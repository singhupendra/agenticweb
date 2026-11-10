import { describe, expect, it } from "vitest";
import { InMemoryRateLimitStore, createRateLimiter, clientKey } from "@/core/security/rate-limit";
import { readBodyWithLimit } from "@/core/security/body-limit";
import { InMemoryReplayGuard } from "@/core/security/replay";

describe("rate limiter", () => {
  const mk = (limit = 3, t = { now: 1_000_000 }) => ({
    t,
    limiter: createRateLimiter({ store: new InMemoryRateLimitStore(), limit, windowMs: 60_000, now: () => t.now }),
  });
  it("allows up to the limit then 429 with Retry-After", async () => {
    const { limiter } = mk();
    for (let i = 0; i < 3; i++) await limiter.consume("k");
    const err = await limiter.consume("k").catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limited", status: 429 });
    expect(Number(err.headers["retry-after"])).toBeGreaterThan(0);
    expect(err.headers["ratelimit-remaining"]).toBe("0");
  });
  it("keys are independent", async () => {
    const { limiter } = mk(1);
    await limiter.consume("a");
    await expect(limiter.consume("b")).resolves.toMatchObject({ remaining: 0 });
  });
  it("window resets", async () => {
    const { limiter, t } = mk(1);
    await limiter.consume("k");
    await expect(limiter.consume("k")).rejects.toMatchObject({ code: "rate_limited" });
    t.now += 60_001;
    await expect(limiter.consume("k")).resolves.toBeDefined();
  });
  it("store is pluggable and bounded", async () => {
    const store = new InMemoryRateLimitStore({ maxKeys: 2 });
    const limiter = createRateLimiter({ store, limit: 5, windowMs: 1000, now: () => 1 });
    await limiter.consume("a"); await limiter.consume("b"); await limiter.consume("c");
    expect(store.size).toBeLessThanOrEqual(2);
  });
  it("clientKey ignores x-forwarded-for unless proxy is trusted", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" } });
    expect(clientKey(req, false)).toBe("ip:unknown");
    expect(clientKey(req, true)).toBe("ip:9.9.9.9");
  });
});

describe("body limit", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("http://x", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  it("reads a small body", async () => expect(await readBodyWithLimit(post('{"a":1}'), 100)).toBe('{"a":1}'));
  it("rejects by content-length", async () =>
    expect(readBodyWithLimit(post("x".repeat(50)), 10)).rejects.toMatchObject({ code: "payload_too_large", status: 413 }));
  it("rejects a lying/missing content-length by counting streamed bytes", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(30))); c.enqueue(new TextEncoder().encode("x".repeat(30))); c.close(); } });
    const req = new Request("http://x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readBodyWithLimit(req, 40)).rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("counts bytes, not characters", async () =>
    expect(readBodyWithLimit(post("é".repeat(10)), 15)).rejects.toMatchObject({ code: "payload_too_large" }));
  it("enforces JSON content-type when requested", async () =>
    expect(readBodyWithLimit(post("a", { "content-type": "text/plain" }), 10, { requireJson: true })).rejects.toMatchObject({ code: "unsupported_media_type" }));
  it("empty body is ''", async () => expect(await readBodyWithLimit(new Request("http://x", { method: "POST" }), 10)).toBe(""));
});

describe("replay guard", () => {
  it("accepts a jti once, rejects replays until expiry", async () => {
    let now = 1000;
    const g = new InMemoryReplayGuard(() => now);
    expect(await g.consume("j1", 2000)).toBe(true);
    expect(await g.consume("j1", 2000)).toBe(false);
    now = 2001;
    expect(await g.consume("j1", 3000)).toBe(true); // pruned after expiry
  });
});
