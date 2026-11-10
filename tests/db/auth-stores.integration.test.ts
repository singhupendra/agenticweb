/**
 * Durable auth/security stores against a REAL Postgres (skipped unless DATABASE_URL_TEST is set; migrations applied).
 * Touches only its own tables (AgentGrant, AgentConfirmation, RateLimitWindow, ReplayEntry).
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PG_POOL_OPTIONS, PrismaConfirmationStore, PrismaGrantStore, PrismaRateLimitStore, PrismaReplayGuard } from "@/core/db";
import { createAccessTokenVerifier, MockIssuer } from "@/core/auth";
import { createRateLimiter } from "@/core/security";
import { AgentConfirmationGate } from "@/agents/policies";
import { agent, ORG_ID, USER_ID, user, user2 } from "../fixtures";

const url = process.env.DATABASE_URL_TEST;
const cap = { name: "bookings.create", mutating: true, requirement: { scope: "bookings:write" as const } };

describe.skipIf(!url)("durable auth stores (Postgres)", () => {
  let db: PrismaClient;
  let t = Date.parse("2026-11-09T10:00:00Z");
  const now = () => t;
  beforeAll(() => { db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, ...PG_POOL_OPTIONS }) }); });
  afterAll(async () => { await db?.$disconnect(); });
  beforeEach(async () => {
    t = Date.parse("2026-11-09T10:00:00Z");
    await db.$executeRawUnsafe('TRUNCATE "AgentGrant","AgentConfirmation","RateLimitWindow","ReplayEntry" CASCADE');
  });

  describe("GrantStore", () => {
    it("round-trips a grant, returns null for unknown, and revocation is immediate + idempotent", async () => {
      const s = new PrismaGrantStore(db);
      await s.put({ grantId: "g1", userId: USER_ID, clientId: "c1", scopes: ["services:read", "bookings:write"] });
      expect(await s.get("g1")).toMatchObject({ grantId: "g1", userId: USER_ID, clientId: "c1", scopes: ["services:read", "bookings:write"], revokedAt: null });
      expect(await s.get("nope")).toBeNull();
      expect(await s.revoke("g1", new Date(t))).toBe(true);
      expect(await s.revoke("g1", new Date(t + 1000))).toBe(false); // already revoked: first revocation time kept
      expect((await s.get("g1"))!.revokedAt).toBe(new Date(t).toISOString());
    });
    it("put never resurrects a revoked grant and cannot change its owner/client", async () => {
      const s = new PrismaGrantStore(db);
      await s.put({ grantId: "g2", userId: USER_ID, clientId: "c1", scopes: ["services:read"] });
      await s.revoke("g2");
      await expect(s.put({ grantId: "g2", userId: USER_ID, clientId: "c1", scopes: ["services:read", "bookings:write"] })).rejects.toThrow(/revoked|exists/i);
      await expect(s.put({ grantId: "g2", userId: "someone-else", clientId: "c1", scopes: [] })).rejects.toThrow();
      expect((await s.get("g2"))!.scopes).toEqual(["services:read"]);
    });
    it("drives the access-token verifier: scopes narrowed to the grant; revoked grant → 401 on the next request", async () => {
      const s = new PrismaGrantStore(db);
      await s.put({ grantId: "g3", userId: USER_ID, clientId: "c1", scopes: ["services:read"] });
      const issuer = await MockIssuer.create("https://idp.test");
      const v = createAccessTokenVerifier({ issuer: "https://idp.test", keys: issuer.keys, grants: s });
      const tok = await issuer.agent({ clientId: "c1", grantId: "g3", scopes: ["services:read", "bookings:write"], userId: USER_ID, organizationId: ORG_ID }, { audience: "https://app.test" });
      const a = await v.verify(tok, ["https://app.test"]);
      expect(a).toMatchObject({ kind: "agent", delegation: { scopes: ["services:read"] } });
      await s.revoke("g3");
      await expect(v.verify(tok, ["https://app.test"])).rejects.toMatchObject({ code: "unauthenticated" });
    });
    it("drops scopes it does not know instead of failing", async () => {
      await db.$executeRawUnsafe(`INSERT INTO "AgentGrant"("grantId","userId","clientId","scopes") VALUES ('g4','u','c',ARRAY['services:read','legacy:thing'])`);
      expect((await new PrismaGrantStore(db).get("g4"))!.scopes).toEqual(["services:read"]);
    });
  });

  describe("ConfirmationStore (via the real gate)", () => {
    const gateOf = (maxEntries?: number) => new AgentConfirmationGate(new PrismaConfirmationStore(db, { maxEntries }), now);
    const ask = async (g: AgentConfirmationGate, input: unknown = { slotId: "s1" }, actor = user) => {
      try { await g.check(actor, cap, input, null, { all: true }); } catch (e) { return (e as { headers: Record<string, string> }).headers["x-confirmation-id"] as string; }
      throw new Error("expected confirmation_required");
    };
    it("approval survives a restart (new gate + new store instance, same database)", async () => {
      const id = await ask(gateOf());
      const restarted = gateOf();
      await restarted.approve(id, user);
      await expect(gateOf().check(user, cap, { slotId: "s1" }, id, { all: true })).resolves.toBeUndefined();
    });
    it("is single-use even when 12 instances race to spend the same approved confirmation", async () => {
      const id = await ask(gateOf());
      await gateOf().approve(id, user);
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => gateOf().check(user, cap, { slotId: "s1" }, id, { all: true })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "forbidden")).toBe(true);
    });
    it("binds actor, tool and arguments; only the owner decides; decline is final", async () => {
      const g = gateOf();
      const id = await ask(g);
      await expect(g.approve(id, user2)).rejects.toMatchObject({ code: "forbidden" });
      await expect(g.approve(id, agent(["bookings:write"]))).rejects.toMatchObject({ code: "forbidden" });
      await g.approve(id, user);
      await expect(g.check(user, cap, { slotId: "OTHER" }, id, { all: true })).rejects.toMatchObject({ code: "forbidden" });
      await expect(g.check(user2, cap, { slotId: "s1" }, id, { all: true })).rejects.toMatchObject({ code: "forbidden" });
      const id2 = await ask(g, { slotId: "s2" });
      await g.decline(id2, user);
      await expect(g.approve(id2, user)).rejects.toMatchObject({ code: "forbidden" });
      await expect(g.check(user, cap, { slotId: "s2" }, id2, { all: true })).rejects.toMatchObject({ code: "forbidden" });
    });
    it("describe returns the preview to the owner only; expired confirmations vanish", async () => {
      const g = gateOf();
      const id = await ask(g, { slotId: "visible" });
      expect((await g.describe(id, user)).preview).toContain("visible");
      await expect(g.describe(id, user2)).rejects.toMatchObject({ code: "not_found" });
      t += 6 * 60_000;
      await expect(g.describe(id, user)).rejects.toMatchObject({ code: "not_found" });
      await expect(g.approve(id, user)).rejects.toMatchObject({ code: "forbidden" });
    });
    it("caps pending per subject (429) and globally, evicting expired rows", async () => {
      const g = gateOf(25);
      for (let i = 0; i < 10; i++) await ask(g, { n: i });
      await expect(g.check(user, cap, { n: 99 }, null, { all: true })).rejects.toMatchObject({ code: "rate_limited" });
      const g2 = gateOf(12);
      await ask(g2, { n: 1 }, user2); await ask(g2, { n: 2 }, user2);
      await expect(g2.check(user2, cap, { n: 3 }, null, { all: true })).rejects.toMatchObject({ code: "rate_limited" }); // 12 live rows already
      t += 6 * 60_000;
      await expect(g2.check(user2, cap, { n: 4 }, null, { all: true })).rejects.toMatchObject({ code: "confirmation_required" }); // expired rows evicted
    });
  });

  describe("RateLimitStore", () => {
    it("counts atomically across concurrent callers and instances (50 racers → counts 1..50 exactly once)", async () => {
      const stores = Array.from({ length: 5 }, () => new PrismaRateLimitStore(db));
      const hits = await Promise.all(Array.from({ length: 50 }, (_, i) => stores[i % 5]!.hit("k", 60_000, t)));
      expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(new Set(hits.map((h) => h.resetAt)).size).toBe(1);
    });
    it("starts a fresh window once the old one ended; keys are independent", async () => {
      const s = new PrismaRateLimitStore(db);
      await s.hit("a", 1000, t); await s.hit("a", 1000, t);
      expect((await s.hit("b", 1000, t)).count).toBe(1);
      const next = await s.hit("a", 1000, t + 1500);
      expect(next).toEqual({ count: 1, resetAt: t + 2500 });
    });
    it("enforces limits via the shared limiter from two 'instances' (429 + Retry-After)", async () => {
      const mk = () => createRateLimiter({ store: new PrismaRateLimitStore(db), limit: 3, windowMs: 60_000, now });
      const [a, b] = [mk(), mk()];
      await a.consume("u"); await b.consume("u"); await a.consume("u");
      await expect(b.consume("u")).rejects.toMatchObject({ code: "rate_limited", headers: { "retry-after": "60" } });
    });
    it("expired windows are swept so the table stays bounded", async () => {
      const s = new PrismaRateLimitStore(db, { sweepEvery: 1 });
      for (let i = 0; i < 20; i++) await s.hit(`old-${i}`, 1000, t);
      await s.hit("new", 1000, t + 5000);
      expect(await db.rateLimitWindow.count()).toBe(1);
    });
    it("fails closed: a database error surfaces (no silent allow)", async () => {
      const broken = new PrismaClient({ adapter: new PrismaPg({ connectionString: "postgresql://postgres@127.0.0.1:1/none" }) });
      await expect(new PrismaRateLimitStore(broken).hit("k", 1000, t)).rejects.toThrow();
      await broken.$disconnect().catch(() => undefined);
    });
  });

  describe("ReplayGuard", () => {
    it("first use wins under concurrency; replays are rejected until expiry, then the id is reusable", async () => {
      const id = randomUUID();
      const guards = Array.from({ length: 4 }, () => new PrismaReplayGuard(db, now));
      const r = await Promise.all(Array.from({ length: 20 }, (_, i) => guards[i % 4]!.consume(id, t + 60_000)));
      expect(r.filter(Boolean)).toHaveLength(1);
      expect(await guards[0]!.consume(id, t + 60_000)).toBe(false);
      t += 61_000;
      expect(await guards[1]!.consume(id, t + 60_000)).toBe(true);
    });
  });
});
