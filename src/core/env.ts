import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().url().refine((u) => u.startsWith("postgres"), "must be a postgres URL"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DEV_AUTH_ENABLED: bool.default(false),
    DEFAULT_ORG_SLUG: z.string().default("northwind-studio"),
    /** OIDC/OAuth issuer whose access tokens we accept (exact `iss` match). */
    AUTH_ISSUER: z.string().url().optional(),
    /** JWKS URL of the issuer. Defaults to `<AUTH_ISSUER>/.well-known/jwks.json`. */
    AUTH_JWKS_URI: z.string().url().optional(),
    /** In-process mock issuer for local dev/tests. Refused in production. */
    MOCK_ISSUER_ENABLED: bool.default(false),
    /** HMAC secret for human session cookies (>= 32 chars). Required in production. */
    SESSION_SECRET: z.string().min(32).optional(),
    /**
     * Where security state lives: `postgres` (grants, human confirmations, rate-limit counters, replay ids — shared by all
     * instances, survives restarts) or `memory` (per-process; unit tests / single throwaway instance). Production refuses `memory`.
     */
    AUTH_STORES: z.enum(["postgres", "memory"]).default("postgres"),
    /** Trust `x-forwarded-for` for per-client rate limiting (only behind a proxy that sets it). */
    TRUST_PROXY: bool.default(false),
    RATE_LIMIT_ANON_PER_MIN: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(240),
    MAX_BODY_BYTES: z.coerce.number().int().positive().default(65536),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.DEV_AUTH_ENABLED) {
      ctx.addIssue({ code: "custom", path: ["DEV_AUTH_ENABLED"], message: "must not be enabled in production" });
    }
    if (env.NODE_ENV === "production") {
      if (env.MOCK_ISSUER_ENABLED) ctx.addIssue({ code: "custom", path: ["MOCK_ISSUER_ENABLED"], message: "must not be enabled in production" });
      if (!env.AUTH_ISSUER) ctx.addIssue({ code: "custom", path: ["AUTH_ISSUER"], message: "required in production" });
      if (env.AUTH_STORES === "memory") ctx.addIssue({ code: "custom", path: ["AUTH_STORES"], message: "must be postgres in production (state must be shared and durable)" });
      if (!env.SESSION_SECRET) ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "required in production" });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return r.data;
}

let cached: Env | undefined;
export function getEnv(): Env {
  return (cached ??= loadEnv(process.env));
}
