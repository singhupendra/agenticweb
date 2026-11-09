import { describe, expect, it } from "vitest";
import { loadEnv } from "@/core/env";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
describe("env validation", () => {
  it("applies defaults", () => expect(loadEnv(base)).toMatchObject({ NODE_ENV: "development", DEV_AUTH_ENABLED: false, LOG_LEVEL: "info" }));
  it("rejects missing DATABASE_URL", () => expect(() => loadEnv({})).toThrow(/DATABASE_URL/));
  it("rejects non-postgres URL", () => expect(() => loadEnv({ DATABASE_URL: "http://x.test" })).toThrow(/postgres/));
  it("rejects DEV_AUTH_ENABLED in production", () =>
    expect(() => loadEnv({ ...base, NODE_ENV: "production", DEV_AUTH_ENABLED: "true" })).toThrow(/DEV_AUTH_ENABLED/));
  it("allows production without dev auth", () => expect(loadEnv({ ...base, NODE_ENV: "production" }).NODE_ENV).toBe("production"));
});
