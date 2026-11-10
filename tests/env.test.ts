import { describe, expect, it } from "vitest";
import { loadEnv } from "@/core/env";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
describe("env validation", () => {
  it("applies defaults", () => expect(loadEnv(base)).toMatchObject({ NODE_ENV: "development", DEV_AUTH_ENABLED: false, LOG_LEVEL: "info" }));
  it("rejects missing DATABASE_URL", () => expect(() => loadEnv({})).toThrow(/DATABASE_URL/));
  it("rejects non-postgres URL", () => expect(() => loadEnv({ DATABASE_URL: "http://x.test" })).toThrow(/postgres/));
  it("rejects DEV_AUTH_ENABLED in production", () =>
    expect(() => loadEnv({ ...base, NODE_ENV: "production", DEV_AUTH_ENABLED: "true" })).toThrow(/DEV_AUTH_ENABLED/));
  const prod = { ...base, NODE_ENV: "production", AUTH_ISSUER: "https://idp.example.com", SESSION_SECRET: "x".repeat(32) };
  it("allows production with issuer + session secret", () => expect(loadEnv(prod).NODE_ENV).toBe("production"));
  it("requires issuer and session secret in production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production" })).toThrow(/AUTH_ISSUER[\s\S]*SESSION_SECRET/);
  });
  it("rejects the mock issuer in production", () => expect(() => loadEnv({ ...prod, MOCK_ISSUER_ENABLED: "true" })).toThrow(/MOCK_ISSUER_ENABLED/));
  it("defaults to durable stores and refuses in-memory stores in production", () => {
    expect(loadEnv(base).AUTH_STORES).toBe("postgres");
    expect(() => loadEnv({ ...prod, AUTH_STORES: "memory" })).toThrow(/AUTH_STORES/);
    expect(loadEnv({ ...base, AUTH_STORES: "memory" }).AUTH_STORES).toBe("memory");
  });
  it("rejects a short session secret", () => expect(() => loadEnv({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/));
});
