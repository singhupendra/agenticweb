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
import { AppError, forbidden } from "@/core/errors";
import { hashInput } from "@/core/logging";

/** Scopes whose use changes state on the user's behalf. */
export const TRANSACTIONAL_SCOPES: readonly Scope[] = ["bookings:write"];
export const CONFIRMATION_HEADER = "x-confirmation-id";
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_PENDING_PER_SUBJECT = 10;

interface Confirmation {
  id: string;
  subject: string;
  userId: string;
  capability: string;
  inputHash: string;
  expiresAt: number;
  status: "pending" | "approved" | "consumed";
}

export interface ConfirmationStore {
  /** Must evict expired entries and refuse (throw) when a global bound is hit. */
  create(c: Confirmation, now: number): Promise<void>;
  /** Live (unexpired, pending) confirmations for a subject, used for the per-subject cap. */
  countPending(subject: string, now: number): Promise<number>;
  get(id: string): Promise<Confirmation | null>;
  /** Atomic compare-and-set; returns false if the current status is not `from`. */
  transition(id: string, from: Confirmation["status"], to: Confirmation["status"]): Promise<boolean>;
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
  async transition(id: string, from: Confirmation["status"], to: Confirmation["status"]) {
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

export class AgentConfirmationGate {
  constructor(
    private readonly store: ConfirmationStore = new InMemoryConfirmationStore(),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  private requires(actor: Actor, cap: GateCapability): actor is Extract<Actor, { kind: "agent" }> {
    const scope = cap.requirement.scope;
    return (
      actor.kind === "agent" && cap.mutating && scope !== undefined && TRANSACTIONAL_SCOPES.includes(scope) &&
      actor.delegation.scopes.includes(scope) && // no scope → the executor denies anyway; don't mint confirmations for it
      effectiveUserId(actor) !== null
    );
  }

  /** Call before invoking a capability. Resolves silently when no confirmation is needed or a valid one is supplied. */
  async check(actor: Actor, cap: GateCapability, input: unknown, confirmationId: string | null | undefined): Promise<void> {
    if (!this.requires(actor, cap)) return;
    const inputHash = hashInput(input);
    if (!confirmationId) {
      const subject = actorSubject(actor);
      if ((await this.store.countPending(subject, this.now())) >= MAX_PENDING_PER_SUBJECT) {
        throw new AppError("rate_limited", "Too many unapproved actions are pending.", { headers: { "retry-after": "60" } });
      }
      const id = randomUUID();
      await this.store.create({
        id, subject: actorSubject(actor), userId: effectiveUserId(actor) as string, capability: cap.name, inputHash,
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
    // approved → consume exactly once (replay protection)
    if (!(await this.store.transition(c.id, "approved", "consumed"))) throw forbidden("Confirmation is invalid or expired.");
  }

  /** A HUMAN approves. Agents can never approve; only the delegating user (admins do not approve for others). */
  async approve(id: string, approver: Actor): Promise<void> {
    if (approver.kind !== "user" && approver.kind !== "admin") throw forbidden("Only the delegating user can approve.");
    const c = await this.store.get(id);
    if (!c || c.userId !== approver.userId || c.expiresAt <= this.now()) throw forbidden("Confirmation is invalid or expired.");
    if (!(await this.store.transition(id, "pending", "approved")) && c.status !== "approved") throw forbidden("Confirmation is invalid or expired.");
  }
}

const g = globalThis as unknown as { __agentGate?: AgentConfirmationGate };
export function getAgentGate(): AgentConfirmationGate {
  return (g.__agentGate ??= new AgentConfirmationGate());
}
