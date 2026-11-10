/**
 * Integration tests against a REAL Postgres. Skipped unless DATABASE_URL_TEST is set (CI sets it).
 * The target database must already have migrations applied: `DATABASE_URL=$DATABASE_URL_TEST pnpm db:deploy`.
 * WARNING: truncates all tables in that database.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { ANONYMOUS, type UserActor } from "@/core/auth";
import { nullLogger } from "@/core/logging";
import { createPrismaRuntime } from "@/runtime";

const url = process.env.DATABASE_URL_TEST;
const H = 3600_000;

describe.skipIf(!url)("bookings against Postgres", () => {
  let db: PrismaClient;
  let orgId: string;
  let serviceId: string;
  const runtime = () => createPrismaRuntime(db, { logger: nullLogger });
  const actorOf = (userId: string): UserActor => ({ kind: "user", userId, organizationId: orgId });
  const key = () => `key-${randomUUID()}`;

  async function makeUser(label = "u") {
    return (await db.user.create({ data: { organizationId: orgId, email: `${label}-${randomUUID()}@t.test`, name: label } })).id;
  }
  async function makeSlot(opts: { capacity?: number; startsInMs?: number } = {}) {
    const startsAt = new Date(Date.now() + (opts.startsInMs ?? 24 * H));
    return (await db.slot.create({ data: { serviceId, startsAt, endsAt: new Date(startsAt.getTime() + H), capacity: opts.capacity ?? 1 } })).id;
  }
  const activeCount = (slotId: string) => db.booking.count({ where: { slotId, status: { not: "cancelled" } } });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE "AuditEvent","IdempotencyRecord","Booking","Slot","Service","User","Organization" CASCADE');
    const org = await db.organization.create({ data: { slug: "acme", name: "Acme" } });
    orgId = org.id;
    serviceId = (await db.service.create({ data: { organizationId: orgId, slug: "svc", name: "Svc", description: "d", durationMinutes: 60, priceMinor: 100, currency: "INR" } })).id;
  });

  it("never overbooks a capacity-1 slot under concurrency (10 racers → exactly 1 winner)", async () => {
    const rt = runtime();
    const slotId = await makeSlot({ capacity: 1 });
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const results = await Promise.allSettled(
      users.map((u) => rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId }, { idempotencyKey: key() })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    expect(failed.every((f) => f.reason?.code === "conflict")).toBe(true);
    expect(await activeCount(slotId)).toBe(1);
  });

  it("respects capacity > 1 under concurrency (10 racers, capacity 3 → exactly 3)", async () => {
    const rt = runtime();
    const slotId = await makeSlot({ capacity: 3 });
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const results = await Promise.allSettled(
      users.map((u) => rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId }, { idempotencyKey: key() })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await activeCount(slotId)).toBe(3);
  });

  it("one user cannot double-book the same slot with different keys concurrently", async () => {
    const rt = runtime();
    const slotId = await makeSlot({ capacity: 5 });
    const u = await makeUser();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId }, { idempotencyKey: key() })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await activeCount(slotId)).toBe(1);
  });

  it("idempotent replay is durable across runtime instances (simulated restart)", async () => {
    const slotId = await makeSlot({ capacity: 2 });
    const u = await makeUser();
    const k = key();
    const first = await runtime().executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId }, { idempotencyKey: k });
    const second = await runtime().executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId }, { idempotencyKey: k });
    expect(second.data).toEqual(first.data);
    expect(await db.booking.count({ where: { slotId } })).toBe(1);
    expect(await db.idempotencyRecord.count()).toBe(1);
    await expect(
      runtime().executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId, notes: "different" }, { idempotencyKey: k }),
    ).rejects.toMatchObject({ code: "idempotency_key_reuse" });
  });

  it("concurrent requests with the SAME key execute once (claim before execute)", async () => {
    const slotId = await makeSlot({ capacity: 5 });
    const u = await makeUser();
    const k = key();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => runtime().executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId }, { idempotencyKey: k })),
    );
    expect(await db.booking.count({ where: { slotId } })).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason.code).toBe("conflict");
    const rec = await db.idempotencyRecord.findMany();
    expect(rec).toHaveLength(1);
    expect(rec[0]?.state).toBe("done");
  });

  it("a failed attempt releases the claim; an expired lease can be superseded", async () => {
    const store = runtime(); // ensures migrations/schema are usable
    void store;
    const { PrismaIdempotencyStore } = await import("@/core/db");
    const s = new PrismaIdempotencyStore(db);
    const now = Date.now();
    expect(await s.claim("sc", "key-aaaaaaaa", "h1", now)).toEqual({ state: "acquired" });
    expect(await s.claim("sc", "key-aaaaaaaa", "h1", now)).toEqual({ state: "in_progress" });
    expect(await s.claim("sc", "key-aaaaaaaa", "h2", now)).toEqual({ state: "mismatch" });
    await s.release("sc", "key-aaaaaaaa");
    expect(await s.claim("sc", "key-aaaaaaaa", "h1", now)).toEqual({ state: "acquired" });
    // lease expires → a new claimant supersedes the crashed one
    expect(await s.claim("sc", "key-aaaaaaaa", "h1", now + 61_000)).toEqual({ state: "acquired" });
    await s.complete("sc", "key-aaaaaaaa", { ok: 1 }, now + 3600_000);
    expect(await s.claim("sc", "key-aaaaaaaa", "h1", now + 62_000)).toEqual({ state: "done", response: { ok: 1 } });
    await s.release("sc", "key-aaaaaaaa"); // no-op on done
    expect((await s.claim("sc", "key-aaaaaaaa", "h1", now + 63_000)).state).toBe("done");
  });

  it("concurrent cancels of one booking all succeed idempotently and end cancelled", async () => {
    const rt = runtime();
    const slotId = await makeSlot();
    const u = await makeUser();
    const b = (await rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId }, { idempotencyKey: key() })).data as { id: string };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => rt.executor.invoke("bookings.cancel", actorOf(u), { orgSlug: "acme", bookingId: b.id }, { idempotencyKey: key() })),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await activeCount(slotId)).toBe(0);
  });

  it("writes durable audit rows for success and denial without raw input", async () => {
    const rt = runtime();
    const slotId = await makeSlot();
    const u = await makeUser();
    await rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId, notes: "very private" }, { idempotencyKey: key(), requestId: "req-1" });
    await expect(rt.executor.invoke("bookings.create", ANONYMOUS, { orgSlug: "acme", slotId }, { idempotencyKey: key(), requestId: "req-2" })).rejects.toBeDefined();
    const rows = await db.auditEvent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(rows.map((r) => [r.requestId, r.outcome, r.capability])).toEqual([
      ["req-1", "success", "bookings.create"],
      ["req-2", "denied", "bookings.create"],
    ]);
    expect(rows[0]?.actorId).toBe(`user:${u}`);
    expect(JSON.stringify(rows)).not.toContain("very private");
    expect(rows[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("slots.list: remaining counts, hides full/past/other services, filters and paginates", async () => {
    const rt = runtime();
    const [a, b, c] = [await makeSlot({ capacity: 2, startsInMs: 2 * H }), await makeSlot({ capacity: 1, startsInMs: 3 * H }), await makeSlot({ capacity: 1, startsInMs: 4 * H })];
    await db.slot.create({ data: { serviceId, startsAt: new Date(Date.now() - 2 * H), endsAt: new Date(Date.now() - H) } }); // past
    const u = await makeUser();
    await rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId: a }, { idempotencyKey: key() });
    await rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId: b }, { idempotencyKey: key() });
    const all = await rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "svc" });
    expect((all.data as { id: string; remaining: number }[]).map((s) => [s.id, s.remaining])).toEqual([[a, 1], [c, 1]]); // b is full
    expect(all.meta.total).toBe(2);
    const paged = await rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "svc", pageSize: 1, page: 2 });
    expect((paged.data as { id: string }[]).map((s) => s.id)).toEqual([c]);
    const filtered = await rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "svc", from: new Date(Date.now() + 3.5 * H).toISOString() });
    expect((filtered.data as { id: string }[]).map((s) => s.id)).toEqual([c]);
  });

  it("ownership via real repositories: list mine, IDOR 404, admin access, cancel frees capacity", async () => {
    const rt = runtime();
    const slotId = await makeSlot({ capacity: 1 });
    const [u1, u2] = [await makeUser("one"), await makeUser("two")];
    const admin = await db.user.create({ data: { organizationId: orgId, email: `admin-${randomUUID()}@t.test`, name: "admin", role: "admin" } });
    const created = (await rt.executor.invoke("bookings.create", actorOf(u1), { orgSlug: "acme", slotId }, { idempotencyKey: key() })).data as { id: string };

    expect((await rt.executor.invoke("bookings.list", actorOf(u1), { orgSlug: "acme" })).data).toHaveLength(1);
    expect((await rt.executor.invoke("bookings.list", actorOf(u2), { orgSlug: "acme" })).data).toHaveLength(0);
    await expect(rt.executor.invoke("bookings.get", actorOf(u2), { orgSlug: "acme", bookingId: created.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.executor.invoke("bookings.cancel", actorOf(u2), { orgSlug: "acme", bookingId: created.id }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "not_found" });
    expect(await activeCount(slotId)).toBe(1);
    await expect(rt.executor.invoke("bookings.get", { kind: "admin", userId: admin.id, organizationId: orgId }, { orgSlug: "acme", bookingId: created.id })).resolves.toBeDefined();

    const cancelled = await rt.executor.invoke("bookings.cancel", actorOf(u1), { orgSlug: "acme", bookingId: created.id }, { idempotencyKey: key() });
    expect(cancelled.data).toMatchObject({ status: "cancelled" });
    await expect(rt.executor.invoke("bookings.create", actorOf(u2), { orgSlug: "acme", slotId }, { idempotencyKey: key() })).resolves.toBeDefined();
  });

  it("rejects past slots and slots of an inactive service; cannot cancel after start", async () => {
    const rt = runtime();
    const u = await makeUser();
    const soon = await makeSlot({ startsInMs: H });
    const booking = (await rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId: soon }, { idempotencyKey: key() })).data as { id: string };
    await db.slot.update({ where: { id: soon }, data: { startsAt: new Date(Date.now() - 2 * H), endsAt: new Date(Date.now() - H) } });
    await expect(rt.executor.invoke("bookings.cancel", actorOf(u), { orgSlug: "acme", bookingId: booking.id }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "conflict" });
    await expect(rt.executor.invoke("bookings.create", actorOf(await makeUser()), { orgSlug: "acme", slotId: soon }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "conflict" });
    await db.service.update({ where: { id: serviceId }, data: { active: false } });
    const other = await makeSlot();
    await expect(rt.executor.invoke("bookings.create", actorOf(u), { orgSlug: "acme", slotId: other }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "not_found" });
  });
});
