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

export interface StoredResponse {
  requestHash: string;
  response: unknown;
  expiresAt: number;
}

export interface IdempotencyStore {
  find(scope: string, key: string): Promise<StoredResponse | null>;
  /** Must be atomic per (scope,key): the Prisma implementation uses the unique index and returns false on conflict. */
  save(scope: string, key: string, value: StoredResponse): Promise<boolean>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, StoredResponse>();
  constructor(private readonly clock: () => number = Date.now) {}
  async find(scope: string, key: string) {
    const v = this.map.get(`${scope}#${key}`);
    if (!v) return null;
    if (v.expiresAt <= this.clock()) {
      this.map.delete(`${scope}#${key}`);
      return null;
    }
    return v;
  }
  async save(scope: string, key: string, value: StoredResponse) {
    const k = `${scope}#${key}`;
    if (this.map.has(k)) return false;
    this.map.set(k, value);
    return true;
  }
}

export function assertValidKey(key: string | undefined): string {
  if (!key) throw new AppError("idempotency_key_required", "This operation requires an Idempotency-Key.");
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AppError("validation_failed", "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-].");
  }
  return key;
}
