/**
 * Idempotency contract for mutating capabilities.
 * REST: `Idempotency-Key` header. MCP: `idempotencyKey` tool argument. Same semantics, same store.
 *  - same scope+key, same request hash → return the stored response (no re-execution)
 *  - same scope+key, different hash    → 422 idempotency_key_reuse
 *  - no key on a mutating capability   → 400 idempotency_key_required
 * Scope = `${capability}|${actorSubject}`, so keys never collide across actors/capabilities.
 */
import { AppError } from "../errors";

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

/**
 * How long an in-progress claim blocks other requests; after this a crashed claimant can be superseded.
 * Must exceed the longest expected mutation duration, otherwise a slow-but-alive request can be superseded.
 */
export const IDEMPOTENCY_LEASE_MS = 60_000;

export type ClaimResult =
  | { state: "acquired" }
  | { state: "in_progress" } //                 another request holds the key right now
  | { state: "done"; response: unknown } //     same key + same payload already completed → replay
  | { state: "mismatch" }; //                   key exists with a different payload

/**
 * Claim-before-execute protocol (no check-then-act):
 *   claim() atomically reserves (scope,key) → execute → complete(); on failure → release().
 * Implementations MUST make claim() atomic per (scope,key) (Postgres: unique index).
 * Residual risk: a crash after the mutation commits but before complete() lets a retry re-execute once
 * the lease expires; mutations should therefore also be naturally idempotent (e.g. unique constraints).
 */
export interface IdempotencyStore {
  claim(scope: string, key: string, requestHash: string, nowMs: number): Promise<ClaimResult>;
  /**
   * Store the result. MUST only apply if the row is still the caller's claim (state in_progress AND same requestHash);
   * a claimant superseded after its lease expired must not overwrite the new claimant (no-op instead).
   */
  complete(scope: string, key: string, requestHash: string, response: unknown, expiresAtMs: number): Promise<void>;
  /** Drop an in-progress claim after a failed attempt so the client can retry. No-op if already completed. */
  release(scope: string, key: string): Promise<void>;
}

interface Entry {
  requestHash: string;
  state: "in_progress" | "done";
  response?: unknown;
  /** done: record expiry. in_progress: lease expiry. */
  until: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, Entry>();
  async claim(scope: string, key: string, requestHash: string, nowMs: number): Promise<ClaimResult> {
    const k = `${scope}#${key}`;
    const e = this.map.get(k);
    if (e && e.until > nowMs) {
      if (e.requestHash !== requestHash) return { state: "mismatch" };
      return e.state === "done" ? { state: "done", response: e.response } : { state: "in_progress" };
    }
    this.map.set(k, { requestHash, state: "in_progress", until: nowMs + IDEMPOTENCY_LEASE_MS });
    return { state: "acquired" };
  }
  async complete(scope: string, key: string, requestHash: string, response: unknown, expiresAtMs: number) {
    const e = this.map.get(`${scope}#${key}`);
    if (e && e.state === "in_progress" && e.requestHash === requestHash) Object.assign(e, { state: "done", response, until: expiresAtMs });
  }
  async release(scope: string, key: string) {
    const k = `${scope}#${key}`;
    if (this.map.get(k)?.state === "in_progress") this.map.delete(k);
  }
}

export function assertValidKey(key: string | undefined): string {
  if (!key) throw new AppError("idempotency_key_required", "This operation requires an Idempotency-Key.");
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AppError("validation_failed", "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-].");
  }
  return key;
}
