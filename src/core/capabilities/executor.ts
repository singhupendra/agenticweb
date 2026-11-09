/**
 * The ONLY pipeline through which behaviour runs:
 *   find → validate input → loadResource → authorize → idempotency → execute → validate output → audit
 * REST, MCP and UI all call `invoke`. Nothing else may call capability.execute.
 */
import { randomUUID } from "node:crypto";
import { actorForAudit, hashInput, type AuditLog, type Logger } from "../logging";
import { actorSubject, type Actor } from "../auth/actor";
import { enforce, type AuthorizationPolicy, isAuthzError, type ResourceRef } from "../authorization";
import { AppError, notFound, validationError, type Envelope, toEnvelope } from "../errors";
import { toIssues } from "../validation";
import { IDEMPOTENCY_TTL_MS, assertValidKey, type IdempotencyStore } from "../idempotency";
import type { CapabilityRegistry } from "./registry";
import type { AnyCapability, CapabilityContext } from "./types";

export interface ExecutorOptions<Deps> {
  registry: CapabilityRegistry<Deps>;
  policy: AuthorizationPolicy;
  audit: AuditLog;
  idempotency: IdempotencyStore;
  logger: Logger;
  deps: Deps;
  clock?: () => Date;
}

export interface InvokeOptions {
  requestId?: string;
  idempotencyKey?: string;
}

export interface CapabilityExecutor {
  /** Returns the success envelope; throws AppError for every failure. */
  invoke(name: string, actor: Actor, rawInput: unknown, opts?: InvokeOptions): Promise<Envelope<unknown>>;
}

export function createExecutor<Deps>(o: ExecutorOptions<Deps>): CapabilityExecutor {
  const clock = o.clock ?? (() => new Date());

  return {
    async invoke(name, actor, rawInput, opts = {}) {
      const requestId = opts.requestId ?? randomUUID();
      const cap: AnyCapability<Deps> | undefined = o.registry.get(name);
      if (!cap) throw notFound("Capability");
      const logger = o.logger.child({ requestId, capability: name });
      const ctx: CapabilityContext<Deps> = { actor, requestId, now: clock(), deps: o.deps, logger };

      const audit = async (outcome: "success" | "denied" | "error", extra: { resource?: ResourceRef | null; detail?: Record<string, unknown> } = {}) => {
        if (!cap.mutating && outcome === "success") return; // reads are not audited on success
        try {
          await o.audit.record({
            occurredAt: clock().toISOString(),
            requestId,
            capability: name,
            outcome,
            actor: actorForAudit(actor),
            organizationId: extra.resource?.organizationId ?? null,
            resource: extra.resource ? { type: extra.resource.type, id: extra.resource.id } : undefined,
            inputHash: hashInput(rawInput),
            detail: extra.detail,
          });
        } catch (e) {
          logger.error("audit write failed", { error: e });
          if (cap.mutating) throw new AppError("internal", "audit unavailable", { cause: e }); // fail closed for mutations
        }
      };

      let resource: ResourceRef | null | undefined;
      try {
        // 1. Validate (before authz: authz may depend on parsed ids; parsing leaks nothing).
        const parsed = cap.input.safeParse(rawInput);
        if (!parsed.success) throw validationError(toIssues(parsed.error));
        const input = parsed.data;

        // 2. Resource facts + authorization
        resource = cap.loadResource ? await cap.loadResource(ctx, input) : undefined;
        if (resource === null) throw notFound();
        enforce(o.policy.decide(actor, cap.requirement, resource));

        // 3. Idempotency (mutations only)
        let scope = "";
        let key = "";
        let requestHash = "";
        if (cap.mutating) {
          key = assertValidKey(opts.idempotencyKey);
          scope = `${name}|${actorSubject(actor)}`;
          requestHash = hashInput(input);
          const prior = await o.idempotency.find(scope, key);
          if (prior) {
            if (prior.requestHash !== requestHash) {
              throw new AppError("idempotency_key_reuse", "This Idempotency-Key was used with a different request.");
            }
            return toEnvelope(prior.response, requestId);
          }
        }

        // 4. Execute + output validation (strips undeclared fields: no accidental data leaks)
        const result = await cap.execute(ctx, input);
        const out = cap.output.safeParse(result);
        if (!out.success) {
          logger.error("output schema violation", { issues: toIssues(out.error) });
          throw new AppError("internal", "output schema violation");
        }

        if (cap.mutating) {
          const saved = await o.idempotency.save(scope, key, { requestHash, response: out.data, expiresAt: clock().getTime() + IDEMPOTENCY_TTL_MS });
          if (!saved) throw new AppError("conflict", "A request with this Idempotency-Key is already in progress.");
        }
        await audit("success", { resource });
        return toEnvelope(out.data, requestId);
      } catch (e) {
        if (isAuthzError(e)) {
          await audit("denied", { resource, detail: { code: e.code } });
        } else if (cap.mutating) {
          await audit("error", { resource, detail: { code: e instanceof AppError ? e.code : "internal" } });
        }
        if (!(e instanceof AppError)) logger.error("unhandled capability error", { error: e });
        throw e;
      }
    },
  };
}
