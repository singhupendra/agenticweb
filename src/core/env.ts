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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.DEV_AUTH_ENABLED) {
      ctx.addIssue({ code: "custom", path: ["DEV_AUTH_ENABLED"], message: "must not be enabled in production" });
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
