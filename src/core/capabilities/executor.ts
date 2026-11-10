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
  /** Caller deadline. Checked before the capability runs (a call aborted before it started never executes); once a mutation has begun it is allowed to finish and be recorded. */
  signal?: AbortSignal;
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
      const ctx: CapabilityContext<Deps> = { actor, requestId, now: clock(), deps: o.deps, logger, signal: opts.signal };

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

        // 3. Idempotency (mutations only): CLAIM the key before executing.
        let scope = "";
        let key = "";
        let claimed = false;
        let requestHash = "";
        if (cap.mutating) {
          key = assertValidKey(opts.idempotencyKey);
          scope = `${name}|${actorSubject(actor)}`;
          requestHash = hashInput(input);
          const claim = await o.idempotency.claim(scope, key, requestHash, clock().getTime());
          if (claim.state === "mismatch") {
            throw new AppError("idempotency_key_reuse", "This Idempotency-Key was used with a different request.");
          }
          if (claim.state === "in_progress") {
            throw new AppError("conflict", "A request with this Idempotency-Key is still in progress.", { headers: { "retry-after": "1" } });
          }
          if (claim.state === "done") {
            // Replays are audited too, so a mutation whose original audit write failed is still recorded on retry.
            await audit("success", { resource, detail: { replayed: true } });
            return toEnvelope(claim.response, requestId);
          }
          claimed = true;
        }

        try {
          if (opts.signal?.aborted) {
            // Nothing has run yet: surface the caller's deadline; the claim is released below so a retry works.
            throw opts.signal.reason instanceof AppError ? opts.signal.reason : new AppError("timeout", "The request was aborted before it started.");
          }
          // 4. Execute + output validation (strips undeclared fields: no accidental data leaks)
          const result = await cap.execute(ctx, input);
          const out = cap.output.safeParse(result);
          if (!out.success) {
            logger.error("output schema violation", { issues: toIssues(out.error) });
            throw new AppError("internal", "output schema violation");
          }
          if (cap.mutating) {
            // The mutation has committed. From here the claim must NEVER be released: if complete() fails the
            // claim stays until its lease expires, so a retry cannot silently run the mutation a second time.
            claimed = false;
            await o.idempotency.complete(scope, key, requestHash, out.data, clock().getTime() + IDEMPOTENCY_TTL_MS);
          }
          // Audit AFTER the result is stored under the key. If this write fails the caller sees a 500 and the
          // retry's replay path writes the audit event, so the mutation cannot stay permanently unaudited.
          await audit("success", { resource });
          return toEnvelope(out.data, requestId);
        } finally {
          // Only reached with claimed=true when execute/output validation failed (nothing committed): safe to release.
          if (claimed) await o.idempotency.release(scope, key).catch((e) => logger.error("idempotency release failed", { error: e }));
        }
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
