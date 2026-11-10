/**
 * Scenario: "book a consultation" through the REAL app via the official MCP SDK client + mock issuer. No LLM.
 * Success is judged on database state, not HTTP 200.
 */
import { describe, expect, it } from "vitest";
import { bookConsultation, humanApprover } from "./support/agent";
import { CUSTOMER_ID, ORG_SLUG, channels, newKey, toolJson } from "./support/clients";

describe("book a consultation over MCP (real app, real DB)", () => {
  it("discover → search → details → compare → availability → select → human approval → book → status → DB truth", async () => {
    const ch = channels();
    const before = await ch.bookingsFor(CUSTOMER_ID);
    const auditBefore = (await ch.auditFor("bookings.create", "success")).length;
    const client = await ch.mcp(await ch.agentToken());
    const run = await bookConsultation(client, ch, { prefs: { choose: "cheapest", notes: "agentic e2e" }, approve: humanApprover(ch) });
    expect(run.reason).toBeUndefined();
    expect(run.ok).toBe(true);

    // The agent picked the cheapest of the seeded services (Quick Consult, 4000.00 INR) after comparing all candidates.
    expect(run.service.slug).toBe("quick-consult");
    expect(run.trace.filter((t) => t.tool === "get_service")).toHaveLength(3);
    // Tool order proves the journey: no write before discovery/search/details/availability.
    const order = run.trace.map((t) => t.tool);
    expect(order.indexOf("list_services")).toBeLessThan(order.indexOf("get_service"));
    expect(order.indexOf("get_service")).toBeLessThan(order.indexOf("list_slots"));
    expect(order.indexOf("list_slots")).toBeLessThan(order.indexOf("create_booking"));
    // First write attempt was blocked pending the human; the second (with approval) succeeded.
    const writes = run.trace.filter((t) => t.tool === "create_booking");
    expect(writes.map((w) => w.code ?? "ok")).toEqual(["confirmation_required", "ok"]);

    // ---- ground truth in Postgres ----
    const after = await ch.bookingsFor(CUSTOMER_ID);
    expect(after.length).toBe(before.length + 1);
    const row = after.find((b) => b.id === run.booking.id)!;
    expect(row).toMatchObject({ status: "confirmed", notes: "agentic e2e", userId: CUSTOMER_ID, slotId: run.slot.id });
    const [svc] = await ch.sql(`SELECT slug FROM "Service" WHERE id=$1`, [row.serviceId]);
    expect(svc!.slug).toBe("quick-consult");
    expect(await ch.activeBookingsOnSlot(run.slot.id)).toHaveLength(1);
    // Sold-out slots are no longer offered through the API either.
    const slots = toolJson(await client.callTool({ name: "list_slots", arguments: { orgSlug: ORG_SLUG, serviceSlug: "quick-consult", from: run.slot.startsAt, to: run.slot.endsAt, pageSize: 5 } }));
    expect(slots.items.find((s: { id: string }) => s.id === run.slot.id)).toBeUndefined();
    // Audit trail attributes the write to the agent acting on behalf of the user, with an input hash and no raw input.
    const audit = await ch.auditFor("bookings.create", "success");
    expect(audit).toHaveLength(auditBefore + 1);
    expect(audit.at(-1)).toMatchObject({ actorKind: "agent", onBehalfOf: CUSTOMER_ID });
    expect(audit.at(-1)!.inputHash).toBeTruthy();
  });

  it("replaying the identical call (same idempotency key + approved confirmation) cannot double-book", async () => {
    const ch = channels();
    const client = await ch.mcp(await ch.agentToken());
    const slot = await ch.freshSlot("strategy-session");
    const key = newKey("agent");
    const args = { orgSlug: ORG_SLUG, slotId: slot.id, idempotencyKey: key };
    const first = toolJson(await client.callTool({ name: "create_booking", arguments: args }));
    expect(first.code).toBe("confirmation_required");
    await humanApprover(ch)(first.confirmationId);
    const ok = toolJson(await client.callTool({ name: "create_booking", arguments: { ...args, confirmationId: first.confirmationId } }));
    expect(ok.status).toBe("confirmed");
    // A confirmation is single-use: replay is rejected, and nothing new is created.
    const replay = await client.callTool({ name: "create_booking", arguments: { ...args, confirmationId: first.confirmationId } });
    expect(replay.isError).toBe(true);
    expect(await ch.activeBookingsOnSlot(slot.id)).toHaveLength(1);
  });
});
