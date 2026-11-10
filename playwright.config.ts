/**
 * Playwright setup (owned by the frontend worker; QA adds scenarios under tests/e2e).
 * Runs against `next dev` because the dev-actor header resolver (DEV_AUTH_ENABLED) is refused in production builds.
 * Requires a migrated + seeded Postgres: E2E_DATABASE_URL (default: local dev database) — see docs/agent-discovery.md.
 */
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;
const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://agenticweb:agenticweb_dev_only@localhost:5432/agenticweb";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
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
    env: { DATABASE_URL: databaseUrl, DEV_AUTH_ENABLED: "true", MOCK_ISSUER_ENABLED: "true", SESSION_SECRET: "e2e-only-session-secret-0123456789-abcdef", AUTH_STORES: "postgres", APP_URL: baseURL, NODE_ENV: "development", LOG_LEVEL: "error" },
  },
});
