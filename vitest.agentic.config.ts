import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Server-backed agentic suites (real Next app + isolated Postgres). Run via `pnpm test:agentic`. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/agentic/**/*.agentic.ts"],
    globalSetup: ["tests/agentic/support/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    reporters: process.env.AGENTIC_JSON ? ["default", ["json", { outputFile: process.env.AGENTIC_JSON }]] : ["default"],
  },
});
