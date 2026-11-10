/**
 * Replay protection for single-use artefacts (confirmation tokens, nonces, one-time grants), keyed by `jti`/nonce.
 * Access tokens are bearer and reusable by design; their replay is bounded by short `exp` + audience + revocation.
 */
export interface ReplayGuard {
  /** true = first use (recorded until `expiresAtMs`); false = replay. Must be atomic per id. */
  consume(id: string, expiresAtMs: number): Promise<boolean>;
}

export class InMemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  async consume(id: string, expiresAtMs: number): Promise<boolean> {
    const t = this.now();
    for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
    if (this.seen.has(id)) return false;
    this.seen.set(id, expiresAtMs);
    return true;
  }
}
