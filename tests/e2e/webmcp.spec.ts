import { expect, test } from "@playwright/test";
import { CUSTOMER_HEADERS } from "./helpers";

/** Minimal WebMCP polyfill matching the 2026-11 draft: document.modelContext.registerTool(tool, { signal }). */
const POLYFILL = () => {
  const tools = new Map<string, { execute: (i: unknown) => Promise<string>; annotations?: Record<string, boolean>; description: string; inputSchema: unknown }>();
  (window as unknown as Record<string, unknown>).__webmcpTools = tools;
  Object.defineProperty(document, "modelContext", {
    value: {
      registerTool(tool: { name: string }, opts?: { signal?: AbortSignal }) {
        tools.set(tool.name, tool as never);
        opts?.signal?.addEventListener("abort", () => tools.delete(tool.name));
      },
    },
  });
};

test("site works fully without WebMCP (no errors, no globals)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/services");
  await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible();
  expect(await page.evaluate(() => "modelContext" in document || "modelContext" in navigator)).toBe(false);
  expect(errors).toEqual([]);
});

test.describe("anonymous with WebMCP polyfill", () => {
  test.beforeEach(async ({ page }) => page.addInitScript(POLYFILL));

  test("registers read-only tools only; list_services returns the same data as REST", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as { __webmcpTools: Map<string, unknown> }).__webmcpTools.size > 0);
    const names = await page.evaluate(() => [...(window as unknown as { __webmcpTools: Map<string, unknown> }).__webmcpTools.keys()]);
    expect(names).toContain("list_services");
    expect(names).not.toContain("create_booking");
    const viaTool = await page.evaluate(async () => JSON.parse(await (window as unknown as { __webmcpTools: Map<string, { execute: (i: unknown) => Promise<string> }> }).__webmcpTools.get("list_services")!.execute({})));
    const viaRest = await (await page.request.get("/api/organizations/northwind-studio/services")).json();
    expect(viaTool.data).toEqual(viaRest.data);
  });

  test("tools stay registered across client-side navigation", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as { __webmcpTools: Map<string, unknown> }).__webmcpTools.size > 0);
    // Client navigation keeps the layout mounted → tools stay registered.
    await page.getByRole("link", { name: "Services" }).first().click();
    await expect(page).toHaveURL(/\/services$/);
    expect(await page.evaluate(() => (window as unknown as { __webmcpTools: Map<string, unknown> }).__webmcpTools.size)).toBeGreaterThan(0);
  });
});

test.describe("signed-in with WebMCP polyfill", () => {
  test.use({ extraHTTPHeaders: CUSTOMER_HEADERS });
  test.beforeEach(async ({ page }) => page.addInitScript(POLYFILL));

  test("mutating tool needs confirmation; declining books nothing, accepting books via REST", async ({ page }) => {
    await page.goto("/services/quick-consult");
    await page.waitForFunction(() => (window as unknown as { __webmcpTools: Map<string, unknown> }).__webmcpTools.has("create_booking"));
    const slotId = await page.getByRole("radio").nth(1).getAttribute("value");

    const call = (input: unknown) =>
      page.evaluate(async (i) => JSON.parse(await (window as unknown as { __webmcpTools: Map<string, { execute: (i: unknown) => Promise<string> }> }).__webmcpTools.get("create_booking")!.execute(i)), input);

    page.once("dialog", (d) => d.dismiss());
    expect((await call({ slotId })).error.code).toBe("user_declined");

    page.once("dialog", (d) => d.accept());
    const created = await call({ slotId });
    expect(created.data.status).toBe("confirmed");

    page.once("dialog", (d) => d.accept());
    const cancelled = await page.evaluate(async (id) => JSON.parse(await (window as unknown as { __webmcpTools: Map<string, { execute: (i: unknown) => Promise<string> }> }).__webmcpTools.get("cancel_booking")!.execute({ bookingId: id })), created.data.id);
    expect(cancelled.data.status).toBe("cancelled");
  });
});

test("/webmcp.json is auth-aware and never cached", async ({ request }) => {
  const anon = await request.get("/webmcp.json");
  expect(anon.headers()["cache-control"]).toContain("no-store");
  expect((await anon.json()).tools.some((t: { mutating: boolean }) => t.mutating)).toBe(false);
  const signed = await request.get("/webmcp.json", { headers: CUSTOMER_HEADERS });
  expect((await signed.json()).tools.some((t: { name: string }) => t.name === "create_booking")).toBe(true);
});
