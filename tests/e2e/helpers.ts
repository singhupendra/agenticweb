import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// Deterministic seed ids (prisma/seed.ts). Dev-only actor header; refused in production.
export const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
export const CUSTOMER_ID = "00000000-0000-4000-8000-0000000000b2";
export const CUSTOMER_HEADERS = { "x-dev-actor": `user|${CUSTOMER_ID}|${ORG_ID}` };

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
