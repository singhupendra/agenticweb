/**
 * WebMCP (progressive enhancement). Spec checked 2026-11-10: W3C Web Machine Learning CG *Draft Community Group
 * Report* (not a standard). API: `document.modelContext.registerTool(tool, { signal })` (earlier drafts and
 * Chrome <150 used `navigator.modelContext`; both are detected). Tool = {name, description, inputSchema, execute, annotations}.
 *
 * Server side: `buildWebMcpManifest` derives the tool list from the capability registry (same Zod schemas, same REST paths).
 * Client side: `registerWebMcp` registers them when the browser supports it and is a strict no-op otherwise.
 * Tools call the same REST endpoints with same-origin credentials, so authentication/authorization are unchanged.
 */
import type { Actor } from "@/core/auth";
import type { CapabilityRegistry } from "@/core/capabilities";
import { IDEMPOTENCY_ARG, listTools } from "@/agents/tools/derive";

export interface WebMcpManifestTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  mutating: boolean;
}
export interface WebMcpManifest { defaults: Record<string, string>; tools: WebMcpManifestTool[] }

const WEBMCP_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function buildWebMcpManifest<Deps>(registry: CapabilityRegistry<Deps>, actor: Actor, defaults: { orgSlug: string }): WebMcpManifest {
  const canMutate = actor.kind === "user" || actor.kind === "admin";
  const tools: WebMcpManifestTool[] = [];
  for (const d of listTools(registry, actor)) {
    const cap = registry.get(d.capability);
    if (!cap || !WEBMCP_NAME.test(d.name)) continue;
    if (cap.mutating && !canMutate) continue; // honour auth: only offer tools the visitor can use
    const schema = structuredClone(d.inputSchema) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
    // orgSlug is fixed by the site; the idempotency key is generated when the caller omits it.
    if (schema.properties?.orgSlug) schema.properties.orgSlug.default = defaults.orgSlug;
    schema.required = (schema.required ?? []).filter((k) => k !== "orgSlug" && k !== IDEMPOTENCY_ARG);
    if (schema.required.length === 0) delete schema.required;
    tools.push({ name: d.name, description: d.description, inputSchema: schema as Record<string, unknown>, method: cap.http.method, pathTemplate: cap.http.path, mutating: cap.mutating });
  }
  return { defaults: { orgSlug: defaults.orgSlug }, tools };
}

/* ---------------- client side ---------------- */

interface ModelContextLike {
  registerTool(tool: unknown, options?: { signal?: AbortSignal }): unknown;
}
export interface WebMcpEnv {
  document?: { modelContext?: ModelContextLike };
  navigator?: { modelContext?: ModelContextLike };
  fetch: typeof fetch;
  confirm: (message: string) => boolean;
  randomUUID: () => string;
}

/** `document.modelContext` is the current spec location; `navigator.modelContext` is the legacy one. */
export function detectModelContext(env: Pick<WebMcpEnv, "document" | "navigator">): ModelContextLike | undefined {
  const mc = env.document?.modelContext ?? env.navigator?.modelContext;
  return mc && typeof mc.registerTool === "function" ? mc : undefined;
}

export function buildRequest(tool: WebMcpManifestTool, rawInput: Record<string, unknown>, defaults: Record<string, string>, uuid: () => string) {
  const input: Record<string, unknown> = { ...defaults, ...rawInput };
  const key = typeof input[IDEMPOTENCY_ARG] === "string" ? (input[IDEMPOTENCY_ARG] as string) : undefined;
  delete input[IDEMPOTENCY_ARG];
  const used = new Set<string>();
  const path = tool.pathTemplate.replace(/\{(\w+)\}/g, (_m, k: string) => {
    used.add(k);
    return encodeURIComponent(String(input[k] ?? ""));
  });
  const rest = Object.fromEntries(Object.entries(input).filter(([k, v]) => !used.has(k) && v !== undefined));
  const headers: Record<string, string> = { accept: "application/json" };
  let url = path;
  let body: string | undefined;
  if (tool.method === "GET") {
    const qs = new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)])).toString();
    if (qs) url += `?${qs}`;
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(rest);
  }
  if (tool.mutating) headers["idempotency-key"] = key ?? uuid();
  return { url, init: { method: tool.method, headers, body, credentials: "same-origin" as const } };
}

/** Registers tools if (and only if) WebMCP exists. Returns a cleanup function. Never throws. */
export function registerWebMcp(env: WebMcpEnv, manifest: WebMcpManifest): () => void {
  const mc = detectModelContext(env);
  if (!mc) return () => undefined;
  const controller = new AbortController();
  for (const tool of manifest.tools) {
    try {
      mc.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: !tool.mutating, consequentialHint: tool.mutating },
          async execute(input: Record<string, unknown> = {}) {
            if (tool.mutating && !env.confirm(`An AI agent wants to run "${tool.name}" on your behalf with these details:\n\n${JSON.stringify(input, null, 2)}\n\nAllow this?`)) {
              return JSON.stringify({ error: { code: "user_declined", detail: "The user declined this action." } });
            }
            const { url, init } = buildRequest(tool, input, manifest.defaults, env.randomUUID);
            const res = await env.fetch(url, init);
            const json: unknown = await res.json().catch(() => ({}));
            return JSON.stringify(res.ok ? json : { error: json, status: res.status });
          },
        },
        { signal: controller.signal },
      );
    } catch {
      /* one bad/duplicate tool must not break the page or other tools */
    }
  }
  return () => controller.abort();
}
