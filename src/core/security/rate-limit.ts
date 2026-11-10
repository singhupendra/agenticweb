/**
 * Fixed-window rate limiting with a pluggable store (in-memory default; swap for Redis/Postgres when running >1 instance).
 * The limiter is channel-agnostic: REST and MCP adapters call `consume(key)` and map the thrown AppError (429) as usual.
 */
import { AppError } from "../errors";

export interface RateLimitStore {
  /** Atomically increment the counter for `key`, starting a new window if the old one ended. */
  hit(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly opts: { maxKeys?: number } = {}) {}
  get size(): number {
    return this.windows.size;
  }
  async hit(key: string, windowMs: number, now: number) {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (!w && this.windows.size >= (this.opts.maxKeys ?? 10_000)) {
        this.sweep(now);
        // Still full of live windows: FAIL CLOSED for new keys. Evicting live windows would let key churn reset a
        // counter (attacker or victim), so overflow keys are rejected instead and nothing is stored.
        if (this.windows.size >= (this.opts.maxKeys ?? 10_000)) return { count: Number.MAX_SAFE_INTEGER, resetAt: now + windowMs };
      }
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, resetAt: w.resetAt };
  }
  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }
}

export interface RateLimitResult {
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface RateLimiter {
  consume(key: string, limitOverride?: number): Promise<RateLimitResult>;
}

export function createRateLimiter(o: {
  store: RateLimitStore;
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = o.now ?? Date.now;
  return {
    async consume(key, limitOverride) {
      const limit = limitOverride ?? o.limit;
      const t = now();
      const { count, resetAt } = await o.store.hit(key, o.windowMs, t);
      const remaining = Math.max(0, limit - count);
      const headers = {
        "ratelimit-limit": String(limit),
        "ratelimit-remaining": String(remaining),
        "ratelimit-reset": String(Math.max(1, Math.ceil((resetAt - t) / 1000))),
      };
      if (count > limit) {
        throw new AppError("rate_limited", "Rate limit exceeded. Retry later.", {
          headers: { ...headers, "retry-after": headers["ratelimit-reset"] },
        });
      }
      return { limit, remaining, resetAt };
    },
  };
}

/** Anonymous clients are keyed by IP only when a trusted proxy sets x-forwarded-for; otherwise one shared bucket. */
export function clientKey(request: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return "ip:unknown";
}
