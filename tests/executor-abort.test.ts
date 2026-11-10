import { describe, expect, it } from "vitest";
import { SLOTS, user, testRuntime } from "./fixtures";

const booking = { orgSlug: "acme", slotId: SLOTS.one.id };
describe("executor honours an AbortSignal", () => {
  it("an already-aborted call never executes, never commits, and releases its idempotency key for a retry", async () => {
    const rt = testRuntime();
    const ac = new AbortController();
    ac.abort();
    await expect(rt.executor.invoke("bookings.create", user, booking, { idempotencyKey: "abort-key-0001", signal: ac.signal })).rejects.toMatchObject({ code: "timeout", status: 504 });
    expect(rt.bookingsRepo.bookings).toHaveLength(0);
    const retry = await rt.executor.invoke("bookings.create", user, booking, { idempotencyKey: "abort-key-0001" });
    expect((retry.data as { slotId: string }).slotId).toBe(SLOTS.one.id);
    expect(rt.bookingsRepo.bookings).toHaveLength(1);
  });
  it("an abort that fires AFTER the mutation committed does not lose the result (still stored + audited)", async () => {
    const rt = testRuntime();
    const ac = new AbortController();
    const orig = rt.bookingsRepo.reserve.bind(rt.bookingsRepo);
    rt.bookingsRepo.reserve = async (...a: Parameters<typeof orig>) => { const r = await orig(...a); ac.abort(); return r; };
    const first = await rt.executor.invoke("bookings.create", user, booking, { idempotencyKey: "abort-key-0002", signal: ac.signal });
    const replay = await rt.executor.invoke("bookings.create", user, booking, { idempotencyKey: "abort-key-0002" });
    expect(replay.data).toEqual(first.data);
    expect(rt.bookingsRepo.bookings).toHaveLength(1);
    expect(rt.auditLog.events.filter((e) => e.outcome === "success")).toHaveLength(2);
  });
  it("capabilities receive the signal in their context", async () => {
    const rt = testRuntime();
    const ac = new AbortController();
    const seen: unknown[] = [];
    const { registry } = await import("@/capabilities");
    const cap = registry.get("organization.get")!;
    const orig = cap.execute;
    cap.execute = async (ctx, input) => { seen.push(ctx.signal); return orig(ctx, input); };
    try { await rt.executor.invoke("organization.get", user, { orgSlug: "acme" }, { signal: ac.signal }); } finally { cap.execute = orig; }
    expect(seen).toEqual([ac.signal]);
  });
});
