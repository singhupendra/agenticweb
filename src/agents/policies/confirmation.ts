/**
 * Agent-specific policy layered on core/authorization: transactional scopes need a per-action HUMAN confirmation.
 *
 * Flow: agent calls a mutating capability → 428 `confirmation_required` + `x-confirmation-id` → the delegating user
 * approves (human actor only, never an agent) → agent retries with the same input and `x-confirmation-id`.
 * A confirmation is bound to (agent subject, capability, input hash), expires quickly and is SINGLE USE (replay-safe).
 * Idempotency still applies on the retry, so a network retry after the mutation does not double-book.
 */
import { randomUUID } from "node:crypto";
import { effectiveUserId, actorSubject, type Actor, type Scope } from "@/core/auth/actor";
import { getPrisma, PrismaConfirmationStore } from "@/core/db";
import { getEnv } from "@/core/env";
import { AppError, forbidden, notFound } from "@/core/errors";
import { hashInput } from "@/core/logging";

/** Scopes whose use changes state on the user's behalf. */
export const TRANSACTIONAL_SCOPES: readonly Scope[] = ["bookings:write"];
export const CONFIRMATION_HEADER = "x-confirmation-id";
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_PENDING_PER_SUBJECT = 10;

export type ConfirmationStatus = "pending" | "approved" | "consumed" | "denied";
export interface Confirmation {
  id: string;
  subject: string;
  userId: string;
  capability: string;
  inputHash: string;
  /** Human-readable copy of the arguments (bounded) shown on the approval screen so the human sees what they approve. */
  preview: string;
  expiresAt: number;
  status: ConfirmationStatus;
}

export interface ConfirmationStore {
  /** Must evict expired entries and refuse (throw) when a global bound is hit. */
  create(c: Confirmation, now: number): Promise<void>;
  /** Live (unexpired, pending) confirmations for a subject, used for the per-subject cap. */
  countPending(subject: string, now: number): Promise<number>;
  get(id: string): Promise<Confirmation | null>;
  /** Atomic compare-and-set; returns false if the current status is not `from`. */
  transition(id: string, from: ConfirmationStatus, to: ConfirmationStatus): Promise<boolean>;
}

export class InMemoryConfirmationStore implements ConfirmationStore {
  private readonly m = new Map<string, Confirmation>();
  constructor(private readonly maxEntries = 10_000) {}
  async create(c: Confirmation, now: number) {
    if (this.m.size >= this.maxEntries) {
      for (const [k, v] of this.m) if (v.expiresAt <= now) this.m.delete(k);
      if (this.m.size >= this.maxEntries) throw new AppError("rate_limited", "Too many pending confirmations.", { headers: { "retry-after": "60" } });
    }
    this.m.set(c.id, { ...c });
  }
  async countPending(subject: string, now: number) {
    let n = 0;
    for (const [k, v] of this.m) {
      if (v.expiresAt <= now) this.m.delete(k); // lazy expiry sweep
      else if (v.subject === subject && v.status === "pending") n++;
    }
    return n;
  }
  async get(id: string) {
    const c = this.m.get(id);
    return c ? { ...c } : null;
  }
  async transition(id: string, from: ConfirmationStatus, to: ConfirmationStatus) {
    const c = this.m.get(id);
    if (!c || c.status !== from) return false;
    c.status = to;
    return true;
  }
}

export interface GateCapability {
  name: string;
  mutating: boolean;
  requirement: { scope?: Scope };
}

export interface ConfirmationView {
  id: string;
  capability: string;
  preview: string;
  expiresAt: string;
  status: ConfirmationStatus;
}

export interface CheckOptions {
  /** Require a human confirmation for EVERY mutating capability, whatever the actor kind (remote MCP: the caller is a model). */
  all?: boolean;
}

const MAX_PREVIEW = 2000;

export class AgentConfirmationGate {
  constructor(
    private readonly store: ConfirmationStore = new InMemoryConfirmationStore(),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  private requires(actor: Actor, cap: GateCapability, all: boolean): boolean {
    if (all) {
      if (!cap.mutating || effectiveUserId(actor) === null) return false; // anonymous / public-only: the executor denies
      return actor.kind !== "agent" || cap.requirement.scope === undefined || actor.delegation.scopes.includes(cap.requirement.scope);
    }
    const scope = cap.requirement.scope;
    return (
      actor.kind === "agent" && cap.mutating && scope !== undefined && TRANSACTIONAL_SCOPES.includes(scope) &&
      actor.delegation.scopes.includes(scope) && // no scope → the executor denies anyway; don't mint confirmations for it
      effectiveUserId(actor) !== null
    );
  }

  /** Call before invoking a capability. Resolves silently when no confirmation is needed or a valid one is supplied. */
  async check(actor: Actor, cap: GateCapability, input: unknown, confirmationId: string | null | undefined, opts: CheckOptions = {}): Promise<void> {
    if (!this.requires(actor, cap, opts.all === true)) return;
    const inputHash = hashInput(input);
    if (!confirmationId) {
      const subject = actorSubject(actor);
      if ((await this.store.countPending(subject, this.now())) >= MAX_PENDING_PER_SUBJECT) {
        throw new AppError("rate_limited", "Too many unapproved actions are pending.", { headers: { "retry-after": "60" } });
      }
      const id = randomUUID();
      await this.store.create({
        id, subject: actorSubject(actor), userId: effectiveUserId(actor) as string, capability: cap.name, inputHash, preview: previewOf(input),
        expiresAt: this.now() + this.ttlMs, status: "pending",
      }, this.now());
      throw new AppError("confirmation_required", "The user must approve this action before it can proceed.", {
        headers: { [CONFIRMATION_HEADER]: id },
      });
    }
    const c = await this.store.get(confirmationId);
    const bound = c && c.subject === actorSubject(actor) && c.capability === cap.name && c.inputHash === inputHash;
    if (!c || !bound || c.expiresAt <= this.now()) throw forbidden("Confirmation is invalid or expired.");
    if (c.status === "pending") {
      throw new AppError("confirmation_required", "The user has not approved this action yet.", { headers: { [CONFIRMATION_HEADER]: c.id } });
    }
    if (c.status === "denied") throw forbidden("Confirmation is invalid or expired.");
    // approved → consume exactly once (replay protection)
    if (!(await this.store.transition(c.id, "approved", "consumed"))) throw forbidden("Confirmation is invalid or expired.");
  }

  /** Only a signed-in human may decide. Agents never; admins only for themselves (never on behalf of another user). */
  private async decidable(id: string, approver: Actor): Promise<Confirmation> {
    if (approver.kind !== "user" && approver.kind !== "admin") throw forbidden("Only the delegating user can approve.");
    const c = await this.store.get(id);
    if (!c || c.userId !== approver.userId || c.expiresAt <= this.now()) throw forbidden("Confirmation is invalid or expired.");
    return c;
  }

  /** A HUMAN approves. Idempotent for an already-approved (unconsumed) confirmation. */
  async approve(id: string, approver: Actor): Promise<void> {
    const c = await this.decidable(id, approver);
    if (!(await this.store.transition(id, "pending", "approved")) && c.status !== "approved") throw forbidden("Confirmation is invalid or expired.");
  }

  /** A HUMAN refuses; the confirmation can never be used afterwards. */
  async decline(id: string, approver: Actor): Promise<void> {
    await this.decidable(id, approver);
    if (!(await this.store.transition(id, "pending", "denied"))) throw forbidden("Confirmation is invalid or expired.");
  }

  /** What the approval screen shows. Only the owner can read it; everyone else gets the same 404 as for an unknown id (no oracle). */
  async describe(id: string, viewer: Actor): Promise<ConfirmationView> {
    const c = await this.store.get(id);
    if ((viewer.kind !== "user" && viewer.kind !== "admin") || !c || c.userId !== viewer.userId || c.expiresAt <= this.now()) throw notFound();
    return { id: c.id, capability: c.capability, preview: c.preview, expiresAt: new Date(c.expiresAt).toISOString(), status: c.status };
  }
}

function previewOf(input: unknown): string {
  const text = JSON.stringify(input, null, 2) ?? "";
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text;
}

const g = globalThis as unknown as { __agentGate?: AgentConfirmationGate };
export function getAgentGate(): AgentConfirmationGate {
  return (g.__agentGate ??= new AgentConfirmationGate(getEnv().AUTH_STORES === "postgres" ? new PrismaConfirmationStore(getPrisma()) : undefined));
}
