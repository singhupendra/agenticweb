import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

/** OpenTelemetry settings. Telemetry is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set. See docs/observability.md. */
export const OtelEnvShape = {
  OTEL_SDK_DISABLED: bool.default(false),
  OTEL_SERVICE_NAME: z.string().min(1).default("agenticweb"),
  /** Empty string counts as unset (compose/K8s pass `VAR=`). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  /** Head-sampling ratio, 0..1 (parent-based). */
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),
};

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
    /** Trust `x-forwarded-for` for per-client rate limiting (only behind a proxy that sets it). */
    TRUST_PROXY: bool.default(false),
    RATE_LIMIT_ANON_PER_MIN: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(240),
    MAX_BODY_BYTES: z.coerce.number().int().positive().default(65536),
    ...OtelEnvShape,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.DEV_AUTH_ENABLED) {
      ctx.addIssue({ code: "custom", path: ["DEV_AUTH_ENABLED"], message: "must not be enabled in production" });
    }
    if (env.NODE_ENV === "production") {
      if (env.MOCK_ISSUER_ENABLED) ctx.addIssue({ code: "custom", path: ["MOCK_ISSUER_ENABLED"], message: "must not be enabled in production" });
      if (!env.AUTH_ISSUER) ctx.addIssue({ code: "custom", path: ["AUTH_ISSUER"], message: "required in production" });
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
