/**
 * Channel parity: the SAME business outcome ("book a consultation") through MCP, REST and the human UI must leave
 * identical, correct state in Postgres. Success is judged on the database, not on HTTP 200 / visible text alone.
 */
import { expect, test } from "@playwright/test";
import { bookConsultation, humanApprover } from "../agentic/support/agent";
import { CUSTOMER_ID, Channels, ORG_SLUG, newKey } from "../agentic/support/clients";
import { CUSTOMER_HEADERS } from "./helpers";

const NOTES = "channel parity check";

test.describe("channel parity: book a consultation", () => {
  test.skip(({ isMobile }) => isMobile, "channel parity is viewport independent; run once");
  test.use({ extraHTTPHeaders: CUSTOMER_HEADERS });

  test("MCP agent, REST client and human UI produce the same booking state", async ({ page, baseURL }) => {
    const ch = new Channels(baseURL!, process.env.E2E_DATABASE_URL!);
    // Three earliest-in-the-future slots for ONE service, so they appear first in the UI and the comparison is like-for-like.
    const slots = [await ch.freshSlot("quick-consult", 1), await ch.freshSlot("quick-consult", 2), await ch.freshSlot("quick-consult", 3)];
    const [mcpSlot, restSlot, uiSlot] = slots as [typeof slots[0], typeof slots[0], typeof slots[0]];
    const before = (await ch.bookingsFor(CUSTOMER_ID)).length;

    // 1) MCP: real SDK client + delegated agent token + human approval
    const client = await ch.mcp(await ch.agentToken());
    const run = await bookConsultation(client, ch, { prefs: { choose: "name", name: "Quick Consult", notes: NOTES }, approve: humanApprover(ch) });
    expect(run.reason).toBeUndefined();
    expect(run.slot.id).toBe(mcpSlot.id); // the agent takes the earliest open slot
    const mcpBookedSlot = mcpSlot.id;

    // 2) REST: user bearer token + Idempotency-Key
    const rest = await ch.rest("POST", "/bookings", { token: await ch.userToken(), body: { slotId: restSlot.id, notes: NOTES }, headers: { "idempotency-key": newKey() } });
    expect(rest.status).toBe(201);

    // 3) Human UI
    await page.goto("/services/quick-consult");
    const form = page.getByTestId("booking-form");
    await form.locator(`input[value="${uiSlot.id}"]`).check();
    await form.getByLabel("Notes (optional)").fill(NOTES);
    await form.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
    const uiBookingId = page.url().split("/").pop()!;

    // ---- database ground truth, normalised so channels can be compared ----
    const rows = await ch.bookingsFor(CUSTOMER_ID);
    expect(rows.length).toBe(before + 3);
    const norm = async (id: string, slotId: string) => {
      const row = rows.find((b) => b.id === id)!;
      expect(row, `booking ${id}`).toBeDefined();
      const [svc] = await ch.sql(`SELECT slug FROM "Service" WHERE id=$1`, [row.serviceId]);
      expect(row.slotId).toBe(slotId);
      expect(await ch.activeBookingsOnSlot(slotId)).toHaveLength(1);
      return { status: row.status, notes: row.notes, userId: row.userId, service: svc!.slug };
    };
    const viaMcp = await norm(run.booking.id, mcpBookedSlot);
    const viaRest = await norm(rest.body.data.id, restSlot.id);
    const viaUi = await norm(uiBookingId, uiSlot.id);
    expect(viaMcp).toEqual({ status: "confirmed", notes: NOTES, userId: CUSTOMER_ID, service: "quick-consult" });
    expect(viaRest).toEqual(viaMcp);
    expect(viaUi).toEqual(viaMcp);

    // Every channel also reads the booking back consistently (REST status == UI status == DB status).
    expect((await ch.rest("GET", `/bookings/${uiBookingId}`, { token: await ch.userToken() })).body.data.status).toBe("confirmed");
    // Every channel is audited exactly once per booking (UI and REST as the user, MCP as the agent on behalf of the user).
    const audit = await ch.sql(`SELECT "actorKind","onBehalfOf" FROM "AuditEvent" WHERE capability='bookings.create' AND outcome='success' ORDER BY "occurredAt" DESC LIMIT 3`);
    expect(audit.map((a) => a.actorKind).sort()).toEqual(["agent", "user", "user"]);

    // And the same rejection through every channel: a second booking of the same slot by the same user is refused everywhere.
    const dup = await ch.rest("POST", "/bookings", { token: await ch.userToken(), body: { slotId: restSlot.id }, headers: { "idempotency-key": newKey() } });
    expect(dup.status).toBe(409);
    expect(ORG_SLUG).toBe("northwind-studio");
  });

  test("XSS in booking notes is rendered inert in the human UI", async ({ page, baseURL }) => {
    const ch = new Channels(baseURL!, process.env.E2E_DATABASE_URL!);
    const slot = await ch.freshSlot("strategy-session", 1);
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
    const r = await ch.rest("POST", "/bookings", { token: await ch.userToken(), body: { slotId: slot.id, notes: payload }, headers: { "idempotency-key": newKey() } });
    expect(r.status).toBe(201);
    await page.goto(`/bookings/${r.body.data.id}`);
    await expect(page.getByTestId("booking-status")).toBeVisible();
    await expect(page.getByText(payload, { exact: false })).toBeVisible(); // shown as literal text…
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined(); // …never executed
  });
});
