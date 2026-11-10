/**
 * Real browser: OIDC sign-in (mock issuer) → my bookings → human approval of an MCP write → sign-out.
 * The browser carries NO dev-actor header: identity comes only from the session cookie created by the callback.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { CUSTOMER_ID, ORG_ID, expectNoAxeViolations } from "./helpers";

const RUN = Date.now().toString(36); // idempotency keys must be unique per run: the database persists between runs
const key = (n: string) => `e2e-${n}-${RUN}`;

async function signIn(page: Page, who: "Demo customer" | "Demo admin" = "Demo customer") {
  await page.goto("/bookings");
  await page.getByTestId("signin-required").getByRole("link", { name: "Sign in" }).click();
  await page.getByRole("link", { name: who }).click(); // mock IdP page
  await expect(page).toHaveURL(/\/bookings$/);
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

async function mcp(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post("/mcp", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { raw: body.result, json: JSON.parse(body.result.content[0].text) };
}

test.describe("OIDC sign-in", () => {
  test("sign in via the mock issuer, see my bookings with the slot start time, sign out", async ({ page, request }) => {
    await signIn(page);
    await expectNoAxeViolations(page);

    // Book through the UI as the signed-in (cookie) customer.
    await page.goto("/services/quick-consult");
    const form = page.getByTestId("booking-form");
    await form.getByRole("radio").nth(2).check();
    await form.getByLabel("Notes (optional)").fill("E2E my-bookings");
    await form.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
    const startsOnDetail = await page.getByTestId("booking-starts").innerText();
    const bookingUrl = page.url();

    await page.goto("/bookings");
    await expect(page.getByRole("heading", { level: 1, name: "My bookings" })).toBeVisible();
    const item = page.getByTestId("booking-item").filter({ has: page.locator(`a[href="${new URL(bookingUrl).pathname}"]`) });
    await expect(item.getByTestId("booking-starts")).toHaveText(startsOnDetail);
    await expect(item.getByTestId("booking-status")).toHaveText("Confirmed");
    await expectNoAxeViolations(page);

    // cleanup + sign-out
    await item.getByRole("link", { name: /Details/ }).click();
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByTestId("booking-status")).toHaveText("Cancelled");
    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("sign-in")).toBeVisible();
    await page.goto("/bookings");
    await expect(page.getByTestId("signin-required")).toBeVisible();
    void request;
  });

  test("an attacker-supplied returnTo cannot leave the site", async ({ page }) => {
    await page.goto("/api/auth/login?returnTo=https%3A%2F%2Fevil.example%2F");
    await page.getByRole("link", { name: "Demo customer" }).click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test("a forged callback without our transaction cookie is rejected", async ({ page }) => {
    const res = await page.request.get("/api/auth/callback?code=forged&state=forged");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("login_failed");
  });
});

test.describe("human approval of an MCP write", () => {
  const book = async (request: APIRequestContext, token: string, slotId: string, confirmationId?: string) =>
    mcp(request, token, "create_booking", { orgSlug: "northwind-studio", slotId, idempotencyKey: key("approval-0001"), ...(confirmationId ? { confirmationId } : {}) });

  test("the model's call is held until the human approves it on /approvals/<id>; the approval works exactly once", async ({ page, request }) => {
    const minted = await request.post("/api/dev/mock-issuer/token", { data: { kind: "user", userId: CUSTOMER_ID, organizationId: ORG_ID, resource: "mcp" } });
    const token = (await minted.json()).access_token as string;
    const slots = await mcp(request, token, "list_slots", { orgSlug: "northwind-studio", serviceSlug: "quick-consult", pageSize: 6 });
    const slotId = slots.json.items[4].id as string;

    const first = await book(request, token, slotId);
    expect(first.raw.isError).toBe(true);
    expect(first.json).toMatchObject({ code: "confirmation_required", status: 428 });
    const { confirmationId, approvalUrl } = first.json as { confirmationId: string; approvalUrl: string };

    // Retrying before approval does nothing.
    expect((await book(request, token, slotId, confirmationId)).json.code).toBe("confirmation_required");

    // A different signed-in user cannot even see it.
    await signIn(page, "Demo admin");
    await page.goto(new URL(approvalUrl).pathname);
    await expect(page.getByTestId("approval-missing")).toBeVisible();
    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("sign-in")).toBeVisible(); // sign-out finished (cookie cleared, page reloaded)

    // The owner sees exactly what will run and approves.
    await signIn(page, "Demo customer");
    await page.goto(new URL(approvalUrl).pathname);
    await expect(page.getByTestId("approval-capability")).toHaveText("bookings.create");
    await expect(page.getByTestId("approval-preview")).toContainText(slotId);
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("approval-result")).toContainText("Approved");

    const done = await book(request, token, slotId, confirmationId);
    expect(done.raw.isError).toBeFalsy();
    expect(done.json).toMatchObject({ slotId, status: "confirmed" });
    expect(done.json.slotStartsAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    // Single use: the spent approval cannot authorise another call.
    const again = await mcp(request, token, "create_booking", { orgSlug: "northwind-studio", slotId, idempotencyKey: key("approval-0002"), confirmationId });
    expect(again.json.code).toBe("forbidden");

    // cleanup
    const cancel1 = await mcp(request, token, "cancel_booking", { orgSlug: "northwind-studio", bookingId: done.json.id, idempotencyKey: key("approval-0003") });
    await page.goto(new URL((cancel1.json as { approvalUrl: string }).approvalUrl).pathname);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("approval-result")).toContainText("Approved");
    const cancelled = await mcp(request, token, "cancel_booking", { orgSlug: "northwind-studio", bookingId: done.json.id, idempotencyKey: key("approval-0003"), confirmationId: cancel1.json.confirmationId });
    expect(cancelled.json.status).toBe("cancelled");
  });

  test("declining blocks the action for good", async ({ page, request }) => {
    const token = (await (await request.post("/api/dev/mock-issuer/token", { data: { kind: "user", userId: CUSTOMER_ID, organizationId: ORG_ID, resource: "mcp" } })).json()).access_token as string;
    const slots = await mcp(request, token, "list_slots", { orgSlug: "northwind-studio", serviceSlug: "quick-consult", pageSize: 6 });
    const slotId = slots.json.items[5].id as string;
    const first = await mcp(request, token, "create_booking", { orgSlug: "northwind-studio", slotId, idempotencyKey: key("decline-0001") });
    await signIn(page);
    await page.goto(new URL(first.json.approvalUrl).pathname);
    await page.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByTestId("approval-result")).toContainText("Declined");
    const retry = await mcp(request, token, "create_booking", { orgSlug: "northwind-studio", slotId, idempotencyKey: key("decline-0001"), confirmationId: first.json.confirmationId });
    expect(retry.json.code).toBe("forbidden");
  });
});
