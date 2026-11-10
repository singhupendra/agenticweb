/**
 * Playwright setup (owned by the frontend worker; QA adds scenarios under tests/e2e).
 * Runs against `next dev` because the dev-actor header resolver (DEV_AUTH_ENABLED) is refused in production builds.
 * Requires a migrated + seeded Postgres: E2E_DATABASE_URL (default: local dev database) — see docs/agent-discovery.md.
 */
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;
// E2E mutates data: it must NEVER run against a dev database. Use `pnpm test:e2e:isolated` (creates a disposable agenticweb_qa_* DB).
const databaseUrl = process.env.E2E_DATABASE_URL ?? "";
if (!new URL(databaseUrl || "postgresql://x/").pathname.startsWith("/agenticweb_qa_")) {
  throw new Error("E2E_DATABASE_URL must point at a disposable database named agenticweb_qa_* — run `pnpm test:e2e:isolated`.");
}

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1, // scenarios share one seeded database
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { DATABASE_URL: databaseUrl, DEV_AUTH_ENABLED: "true", MOCK_ISSUER_ENABLED: "true", SESSION_SECRET: "e2e-only-session-secret-0123456789-abcdef", AUTH_STORES: "postgres", RATE_LIMIT_ANON_PER_MIN: "100000", RATE_LIMIT_AUTH_PER_MIN: "100000", APP_URL: baseURL, NODE_ENV: "development", LOG_LEVEL: "error" },
  },
});
