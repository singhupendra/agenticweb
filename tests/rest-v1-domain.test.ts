import { describe, expect, it } from "vitest";
import { ANONYMOUS } from "@/core/auth";
import { SLOTS, admin, outsider, testRuntime, user, user2 } from "./fixtures";

const K = (n: number) => ({ idempotencyKey: `idem-key-${String(n).padStart(4, "0")}` });
const inv = (rt: ReturnType<typeof testRuntime>, name: string, actor: Parameters<typeof rt.executor.invoke>[1], input: object, key?: number) =>
  rt.executor.invoke(name, actor, input, key ? K(key) : {});

describe("services.list filtering and sorting", () => {
  it("sorts by name desc and by price", async () => {
    const rt = testRuntime();
    const r = await inv(rt, "services.list", ANONYMOUS, { orgSlug: "acme", sort: "-name" });
    expect((r.data as { slug: string }[]).map((s) => s.slug)).toEqual(["service-2", "service-1"]);
  });
  it("filters by name substring and max price", async () => {
    const rt = testRuntime();
    const r = await inv(rt, "services.list", ANONYMOUS, { orgSlug: "acme", q: "service 2" });
    expect((r.data as { slug: string }[]).map((s) => s.slug)).toEqual(["service-2"]);
    const none = await inv(rt, "services.list", ANONYMOUS, { orgSlug: "acme", maxPriceMinor: 1 });
    expect(none.data).toEqual([]);
    expect(none.meta.total).toBe(0);
  });
  it("rejects unknown sort keys and negative prices", async () => {
    const rt = testRuntime();
    await expect(inv(rt, "services.list", ANONYMOUS, { orgSlug: "acme", sort: "secret" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(inv(rt, "services.list", ANONYMOUS, { orgSlug: "acme", maxPriceMinor: -1 })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("slots.list sorting", () => {
  it("sorts latest first with -startsAt", async () => {
    const rt = testRuntime();
    const r = await inv(rt, "slots.list", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-1", sort: "-startsAt" });
    expect((r.data as { id: string }[]).map((s) => s.id)).toEqual([SLOTS.later.id, SLOTS.two.id, SLOTS.one.id]);
  });
});

describe("bookings.list filtering and sorting", () => {
  it("filters by status and sorts by createdAt", async () => {
    const rt = testRuntime();
    const a = (await inv(rt, "bookings.create", user, { orgSlug: "acme", slotId: SLOTS.one.id }, 1)).data as { id: string };
    await inv(rt, "bookings.create", user, { orgSlug: "acme", slotId: SLOTS.two.id }, 2);
    await inv(rt, "bookings.cancel", user, { orgSlug: "acme", bookingId: a.id }, 3);
    const cancelled = await inv(rt, "bookings.list", user, { orgSlug: "acme", status: "cancelled" });
    expect((cancelled.data as { id: string }[]).map((b) => b.id)).toEqual([a.id]);
    const confirmed = await inv(rt, "bookings.list", user, { orgSlug: "acme", status: "confirmed", sort: "createdAt" });
    expect(confirmed.meta.total).toBe(1);
    await expect(inv(rt, "bookings.list", user, { orgSlug: "acme", status: "bogus" })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("bookings.update (PATCH notes)", () => {
  const make = async () => {
    const rt = testRuntime();
    const b = (await inv(rt, "bookings.create", user, { orgSlug: "acme", slotId: SLOTS.one.id, notes: "old" }, 1)).data as { id: string };
    return { rt, id: b.id };
  };
  it("owner and admin can update notes; null clears", async () => {
    const { rt, id } = await make();
    const r = await inv(rt, "bookings.update", user, { orgSlug: "acme", bookingId: id, notes: "new" }, 2);
    expect(r.data).toMatchObject({ id, notes: "new", status: "confirmed" });
    const c = await inv(rt, "bookings.update", admin, { orgSlug: "acme", bookingId: id, notes: null }, 3);
    expect(c.data).toMatchObject({ notes: null });
  });
  it("requires auth, key, ownership (404 for others), and a notes field", async () => {
    const { rt, id } = await make();
    await expect(inv(rt, "bookings.update", ANONYMOUS, { orgSlug: "acme", bookingId: id, notes: "x" }, 2)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(inv(rt, "bookings.update", user, { orgSlug: "acme", bookingId: id, notes: "x" })).rejects.toMatchObject({ code: "idempotency_key_required" });
    await expect(inv(rt, "bookings.update", user2, { orgSlug: "acme", bookingId: id, notes: "x" }, 4)).rejects.toMatchObject({ code: "not_found" });
    await expect(inv(rt, "bookings.update", outsider, { orgSlug: "acme", bookingId: id, notes: "x" }, 5)).rejects.toMatchObject({ code: "not_found" });
    await expect(inv(rt, "bookings.update", user, { orgSlug: "acme", bookingId: id }, 6)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(inv(rt, "bookings.update", user, { orgSlug: "acme", bookingId: id, notes: "x", status: "confirmed" }, 7)).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("cannot modify a cancelled booking (409)", async () => {
    const { rt, id } = await make();
    await inv(rt, "bookings.cancel", user, { orgSlug: "acme", bookingId: id }, 2);
    await expect(inv(rt, "bookings.update", user, { orgSlug: "acme", bookingId: id, notes: "x" }, 3)).rejects.toMatchObject({ code: "conflict" });
  });
  it("is idempotent per key", async () => {
    const { rt, id } = await make();
    const a = await inv(rt, "bookings.update", user, { orgSlug: "acme", bookingId: id, notes: "n" }, 2);
    const b = await inv(rt, "bookings.update", user, { orgSlug: "acme", bookingId: id, notes: "n" }, 2);
    expect(b.data).toEqual(a.data);
  });
});
