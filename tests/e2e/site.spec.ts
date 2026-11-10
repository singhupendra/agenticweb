import { expect, test } from "@playwright/test";
import { CUSTOMER_HEADERS, expectNoAxeViolations } from "./helpers";

test.describe("anonymous visitor", () => {
  test("home: landmarks, heading hierarchy, services, FAQ, no axe violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(page.getByRole("link", { name: "Strategy Session" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Frequently asked questions" })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("home JSON-LD FAQ matches the visible FAQ", async ({ page }) => {
    await page.goto("/");
    const nodes = await page.locator('script[type="application/ld+json"]').evaluateAll((els) => els.map((e) => JSON.parse(e.textContent ?? "")));
    const types = nodes.map((n) => n["@type"]).sort();
    expect(types).toEqual(["FAQPage", "Organization", "WebPage", "WebSite"]);
    const faq = nodes.find((n) => n["@type"] === "FAQPage");
    for (const q of faq.mainEntity) {
      await expect(page.getByText(q.name, { exact: true })).toBeVisible();
      await expect(page.getByText(q.acceptedAnswer.text, { exact: true })).toBeVisible();
    }
  });

  test("skip link is the first tab stop and moves focus to main", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard navigation is a desktop concern");
    const skip = page.getByRole("link", { name: "Skip to content" });
    // `next dev` may full-reload once while compiling on first hit; retry from a fresh load until focus sticks.
    await expect(async () => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Tab");
      await expect(skip).toBeFocused({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  test("services list → detail with availability, JSON-LD Service/Offer, sign-in notice", async ({ page }) => {
    await page.goto("/services");
    await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole("link", { name: "Quick Consult" }).click();
    await expect(page).toHaveURL(/\/services\/quick-consult$/);
    await expect(page.getByRole("heading", { level: 1, name: "Quick Consult" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Availability" })).toBeVisible();
    await expect(page.getByTestId("signin-required")).toBeVisible();
    await expect(page.getByTestId("booking-form")).toHaveCount(0);
    const service = await page.locator('script[type="application/ld+json"]').evaluateAll((els) => els.map((e) => JSON.parse(e.textContent ?? "")).find((n) => n["@type"] === "Service"));
    expect(service.offers).toMatchObject({ "@type": "Offer", price: "4000.00", priceCurrency: "INR" });
    await expectNoAxeViolations(page);
  });

  test("unknown service → not-found page", async ({ page }) => {
    await page.goto("/services/does-not-exist");
    // Next streams the shell first (loading.tsx), so status stays 200 but it injects noindex (documented behaviour).
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("no horizontal overflow at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of ["/", "/services", "/services/quick-consult"]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("booking page asks anonymous visitors to sign in", async ({ page }) => {
    await page.goto("/bookings/00000000-0000-4000-8000-000000000999");
    await expect(page.getByTestId("signin-required")).toBeVisible();
  });
});

test.describe("signed-in customer (dev actor)", () => {
  test.use({ extraHTTPHeaders: CUSTOMER_HEADERS });

  test("book a slot, see status, cancel", async ({ page }) => {
    await page.goto("/services/quick-consult");
    const form = page.getByTestId("booking-form");
    await expect(form).toBeVisible();
    await page.waitForLoadState("networkidle"); // let React hydrate before interacting (slow cold `next dev` on CI otherwise posts an empty slotId)
    await expectNoAxeViolations(page);

    // Validation: submitting without a slot shows an announced error.
    await form.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    // Keyboard-selectable radio group; pick the last slot to avoid clashing with other scenarios.
    const radios = form.getByRole("radio");
    await radios.last().check();
    await form.getByLabel("Notes (optional)").fill("E2E booking");
    await form.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Booking status" })).toBeVisible();
    await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
    await expect(page.getByText("E2E booking")).toBeVisible();
    await expectNoAxeViolations(page);

    await page.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByTestId("booking-status")).toHaveText("Cancelled");
    await expect(page.getByRole("button", { name: "Cancel booking" })).toHaveCount(0);
  });

  test("another user's / unknown booking id → not found (no information leak)", async ({ page }) => {
    await page.goto("/bookings/00000000-0000-4000-8000-000000000999");
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});

test.describe("machine-readable discovery", () => {
  test("robots.txt", async ({ request }) => {
    const res = await request.get("/robots.txt");
    expect(res.headers()["content-type"]).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("User-agent: GPTBot");
    expect(body).toMatch(/Sitemap: http:\/\/localhost:\d+\/sitemap\.xml/);
  });
  test("sitemap.xml lists services", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.headers()["content-type"]).toContain("xml");
    const body = await res.text();
    expect(body).toContain("/services/strategy-session</loc>");
    expect(body).not.toContain("/api/");
  });
  test("llms.txt", async ({ request }) => {
    const body = await (await request.get("/llms.txt")).text();
    expect(body.startsWith("# Northwind Studio")).toBe(true);
    expect(body).toContain("/services/quick-consult");
  });
});
