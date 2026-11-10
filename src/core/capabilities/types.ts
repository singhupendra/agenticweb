/**
 * Capability = the single definition of a product behaviour. REST routes, MCP tools, OpenAPI and UI calls
 * are ALL derived from / routed through it. Adding behaviour anywhere else is a contract violation.
 */
import type { z } from "zod";
import type { Actor } from "../auth/actor";
import type { Requirement, ResourceRef } from "../authorization";
import type { Logger } from "../logging";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CapabilityContext<Deps> {
  actor: Actor;
  requestId: string;
  now: Date;
  deps: Deps;
  logger: Logger;
}

export interface HttpBinding {
  method: HttpMethod;
  /** Next-style OpenAPI path template, e.g. `/api/organizations/{orgSlug}/services`. `{param}` values feed `input`. */
  path: string;
  successStatus?: number;
}

export interface McpBinding {
  /** snake_case, globally unique. */
  toolName: string;
  /** Opt-in. Capabilities are NOT exposed to agents unless true (admin-only caps must stay false). */
  exposed: boolean;
  /** Human/LLM-facing description. STATIC text only: never interpolate user content (tool poisoning). */
  description?: string;
}

export interface Capability<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, Deps = unknown> {
  /** `<module>.<verb>` e.g. `services.list`. Unique. */
  name: string;
  summary: string;
  input: I;
  output: O;
  requirement: Requirement;
  /** true → requires idempotency key, always audited, never exposed as GET. */
  mutating: boolean;
  http: HttpBinding;
  mcp: McpBinding;
  /**
   * Fetch the authorization facts for the target (owner/org). Return null if it does not exist.
   * Runs BEFORE execute and BEFORE any data is returned. Must not leak data.
   */
  loadResource?: (ctx: CapabilityContext<Deps>, input: z.output<I>) => Promise<ResourceRef | null>;
  execute: (ctx: CapabilityContext<Deps>, input: z.output<I>) => Promise<z.input<O>>;
}

/** Identity helper that preserves inference. */
export function defineCapability<I extends z.ZodType, O extends z.ZodType, Deps>(
  cap: Capability<I, O, Deps>,
): Capability<I, O, Deps> {
  return cap;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability<Deps = unknown> = Capability<any, any, Deps>;
