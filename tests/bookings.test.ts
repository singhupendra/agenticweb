import { describe, expect, it } from "vitest";
import { ANONYMOUS } from "@/core/auth";
import { formatSlotStart } from "@/modules/bookings/present";
import { SLOTS, admin, agent, outsider, testRuntime, user, user2 } from "./fixtures";

const K = (n: number) => ({ idempotencyKey: `idem-key-${String(n).padStart(4, "0")}` });
const book = (rt: ReturnType<typeof testRuntime>, actor: Parameters<typeof rt.executor.invoke>[1], slotId: string, key = 1, extra: object = {}) =>
  rt.executor.invoke("bookings.create", actor, { orgSlug: "acme", slotId, ...extra }, K(key));
type Booking = { id: string; status: string; slotId: string };

describe("slots.list", () => {
  it("lists only future, active-service, available slots, soonest first", async () => {
    const rt = testRuntime();
    const r = await rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-1" });
    expect((r.data as { id: string }[]).map((s) => s.id)).toEqual([SLOTS.one.id, SLOTS.two.id, SLOTS.later.id]);
    expect(r.meta.total).toBe(3);
  });
  it("hides full slots and reports remaining capacity", async () => {
    const rt = testRuntime();
    await book(rt, user, SLOTS.one.id);
    await book(rt, user, SLOTS.two.id, 2);
    const r = await rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-1" });
    const data = r.data as { id: string; remaining: number }[];
    expect(data.map((s) => s.id)).toEqual([SLOTS.two.id, SLOTS.later.id]);
    expect(data[0]?.remaining).toBe(1);
  });
  it("filters by from/to and paginates", async () => {
    const rt = testRuntime();
    const r = await rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-1", from: SLOTS.two.startsAt.toISOString(), pageSize: 1 });
    expect(r.data).toHaveLength(1);
    expect(r.meta).toMatchObject({ total: 2, pageSize: 1 });
  });
  it("404 for unknown or inactive service; 400 for bad dates", async () => {
    const rt = testRuntime();
    await expect(rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-3" })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.executor.invoke("slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-1", from: "yesterday" })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("bookings.create", () => {
  it("creates a confirmed booking for the actor and hides owner fields", async () => {
    const rt = testRuntime();
    const r = await book(rt, user, SLOTS.one.id, 1, { notes: "hello" });
    expect(r.data).toMatchObject({ status: "confirmed", slotId: SLOTS.one.id, notes: "hello" });
    expect(r.data).not.toHaveProperty("userId");
    expect(rt.bookingsRepo.bookings[0]?.userId).toBe(user.userId);
  });
  it("never accepts userId/status from input", async () => {
    const rt = testRuntime();
    await expect(book(rt, user, SLOTS.one.id, 1, { userId: user2.userId })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(book(rt, user, SLOTS.one.id, 1, { status: "confirmed" })).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("requires authentication and an idempotency key", async () => {
    const rt = testRuntime();
    await expect(book(rt, ANONYMOUS, SLOTS.one.id)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(rt.executor.invoke("bookings.create", user, { orgSlug: "acme", slotId: SLOTS.one.id })).rejects.toMatchObject({ code: "idempotency_key_required" });
  });
  it("replays the same key without a second booking; different payload → 422", async () => {
    const rt = testRuntime();
    const a = await book(rt, user, SLOTS.two.id, 7);
    const b = await book(rt, user, SLOTS.two.id, 7);
    expect(b.data).toEqual(a.data);
    expect(rt.bookingsRepo.bookings).toHaveLength(1);
    await expect(book(rt, user, SLOTS.one.id, 7)).rejects.toMatchObject({ code: "idempotency_key_reuse" });
  });
  it("conflicts: full slot, duplicate by same user, past slot", async () => {
    const rt = testRuntime();
    await book(rt, user, SLOTS.one.id, 1);
    await expect(book(rt, user2, SLOTS.one.id, 2)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("fully booked") });
    await book(rt, user, SLOTS.two.id, 3);
    await expect(book(rt, user, SLOTS.two.id, 4)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("already have") });
    await expect(book(rt, user, SLOTS.past.id, 5)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("started") });
  });
  it("404 for unknown slot, other-org slot, inactive-service slot", async () => {
    const rt = testRuntime();
    for (const id of ["00000000-0000-4000-8000-000000000000", SLOTS.otherOrg.id, SLOTS.inactive.id]) {
      await expect(book(rt, user, id)).rejects.toMatchObject({ code: "not_found" });
    }
  });
  it("a user of another organization cannot book here (tenant isolation)", async () => {
    await expect(book(testRuntime(), outsider, SLOTS.one.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("agent needs bookings:write and a user to act for; books as that user", async () => {
    const rt = testRuntime();
    await expect(book(rt, agent(["bookings:read"]), SLOTS.one.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(book(rt, agent(["bookings:write"], { publicOnly: true }), SLOTS.one.id)).rejects.toMatchObject({ code: "unauthenticated" });
    await book(rt, agent(["bookings:write"]), SLOTS.one.id);
    expect(rt.bookingsRepo.bookings[0]?.userId).toBe(user.userId);
  });
  it("audits success and denial with hashed input only", async () => {
    const rt = testRuntime();
    await book(rt, user, SLOTS.one.id, 1, { notes: "private note" });
    await expect(book(rt, ANONYMOUS, SLOTS.one.id)).rejects.toBeDefined();
    expect(rt.auditLog.events.map((e) => e.outcome)).toEqual(["success", "denied"]);
    expect(JSON.stringify(rt.auditLog.events)).not.toContain("private note");
    expect(rt.auditLog.events[0]).toMatchObject({ capability: "bookings.create", actor: { kind: "user" }, resource: { type: "organization" } });
  });
});

describe("bookings.list / get (ownership, IDOR)", () => {
  it("lists only the caller's bookings", async () => {
    const rt = testRuntime();
    await book(rt, user, SLOTS.one.id, 1);
    await book(rt, user2, SLOTS.two.id, 2);
    const mine = await rt.executor.invoke("bookings.list", user, { orgSlug: "acme" });
    expect(mine.data).toHaveLength(1);
    expect(mine.meta.total).toBe(1);
    await expect(rt.executor.invoke("bookings.list", ANONYMOUS, { orgSlug: "acme" })).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("owner and admin can get; other user gets 404; unknown id 404; agent needs scope", async () => {
    const rt = testRuntime();
    const b = (await book(rt, user, SLOTS.one.id)).data as Booking;
    const get = (actor: Parameters<typeof rt.executor.invoke>[1], id = b.id) => rt.executor.invoke("bookings.get", actor, { orgSlug: "acme", bookingId: id });
    await expect(get(user)).resolves.toBeDefined();
    await expect(get(admin)).resolves.toBeDefined();
    await expect(get(user2)).rejects.toMatchObject({ code: "not_found" });
    await expect(get(outsider)).rejects.toMatchObject({ code: "not_found" });
    await expect(get(user, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
    await expect(get(agent(["services:read"]))).rejects.toMatchObject({ code: "forbidden" });
    await expect(get(agent(["bookings:read"]))).resolves.toBeDefined();
  });
});

describe("bookings.cancel", () => {
  const cancel = (rt: ReturnType<typeof testRuntime>, actor: Parameters<typeof rt.executor.invoke>[1], id: string, key = 50) =>
    rt.executor.invoke("bookings.cancel", actor, { orgSlug: "acme", bookingId: id }, K(key));
  it("cancels, frees capacity, and is idempotent on repeat", async () => {
    const rt = testRuntime();
    const b = (await book(rt, user, SLOTS.one.id)).data as Booking;
    expect(((await cancel(rt, user, b.id)).data as Booking).status).toBe("cancelled");
    expect(((await cancel(rt, user, b.id, 51)).data as Booking).status).toBe("cancelled");
    await expect(book(rt, user2, SLOTS.one.id, 2)).resolves.toBeDefined();
  });
  it("non-owner gets 404 and nothing changes; admin may cancel", async () => {
    const rt = testRuntime();
    const b = (await book(rt, user, SLOTS.one.id)).data as Booking;
    await expect(cancel(rt, user2, b.id)).rejects.toMatchObject({ code: "not_found" });
    expect(rt.bookingsRepo.bookings[0]?.status).toBe("confirmed");
    expect(rt.auditLog.events.at(-1)).toMatchObject({ outcome: "denied", capability: "bookings.cancel" });
    await expect(cancel(rt, admin, b.id, 52)).resolves.toBeDefined();
  });
  it("cannot cancel once the slot has started", async () => {
    const rt = testRuntime();
    const b = (await book(rt, user, SLOTS.one.id)).data as Booking;
    rt.bookingsRepo.bookings[0]!.slotId = SLOTS.past.id; // simulate time passing
    await expect(cancel(rt, user, b.id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("requires an idempotency key", async () => {
    const rt = testRuntime();
    const b = (await book(rt, user, SLOTS.one.id)).data as Booking;
    await expect(rt.executor.invoke("bookings.cancel", user, { orgSlug: "acme", bookingId: b.id })).rejects.toMatchObject({ code: "idempotency_key_required" });
  });
});

describe("presentation", () => {
  it("renders slot time in the organization's timezone", () => {
    expect(formatSlotStart("2026-11-10T05:00:00.000Z", "Asia/Kolkata", "en-GB")).toContain("10:30");
  });
});
