import type { AnyCapability } from "./types";

export interface CapabilityRegistry<Deps = unknown> {
  all(): readonly AnyCapability<Deps>[];
  get(name: string): AnyCapability<Deps> | undefined;
  byMcpTool(toolName: string): AnyCapability<Deps> | undefined;
  /** Match an HTTP method + concrete path to a capability and extract path params. */
  matchHttp(method: string, pathname: string): { capability: AnyCapability<Deps>; params: Record<string, string> } | undefined;
}

const NAME = /^[a-z]+\.[a-z_]+$/;
const TOOL = /^[a-z][a-z0-9_]*$/;

function compile(path: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_m, k: string) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { re: new RegExp(`^${src}/?$`), keys };
}

/** Build and VALIDATE a registry: duplicate names/routes/tools and mutating-GET are rejected at startup. */
export function createRegistry<Deps>(caps: readonly AnyCapability<Deps>[]): CapabilityRegistry<Deps> {
  const names = new Set<string>();
  const routes = new Set<string>();
  const tools = new Set<string>();
  for (const c of caps) {
    if (!NAME.test(c.name)) throw new Error(`Invalid capability name "${c.name}" (expected module.verb)`);
    if (names.has(c.name)) throw new Error(`Duplicate capability "${c.name}"`);
    names.add(c.name);
    const route = `${c.http.method} ${c.http.path}`;
    if (routes.has(route)) throw new Error(`Duplicate HTTP route "${route}"`);
    routes.add(route);
    if (!TOOL.test(c.mcp.toolName)) throw new Error(`Invalid MCP tool name "${c.mcp.toolName}"`);
    if (tools.has(c.mcp.toolName)) throw new Error(`Duplicate MCP tool "${c.mcp.toolName}"`);
    tools.add(c.mcp.toolName);
    if (c.mutating && c.http.method === "GET") throw new Error(`Mutating capability "${c.name}" cannot use GET`);
    if (!c.mutating && c.http.method !== "GET") throw new Error(`Read capability "${c.name}" must use GET`);
    if (c.mcp.exposed && c.requirement.access === "admin") throw new Error(`Admin capability "${c.name}" must not be exposed to MCP`);
    if (c.mcp.exposed && !c.requirement.scope) throw new Error(`MCP-exposed capability "${c.name}" must declare a scope`);
    if (c.requirement.access === "owner-or-admin" && !c.loadResource) {
      throw new Error(`Capability "${c.name}" uses owner-or-admin but has no loadResource`);
    }
  }
  const compiled = caps.map((c) => ({ c, ...compile(c.http.path) }));
  return {
    all: () => caps,
    get: (n) => caps.find((c) => c.name === n),
    byMcpTool: (t) => caps.find((c) => c.mcp.toolName === t),
    matchHttp(method, pathname) {
      for (const { c, re, keys } of compiled) {
        if (c.http.method !== method) continue;
        const m = re.exec(pathname);
        if (m) return { capability: c, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? "")])) };
      }
      return undefined;
    },
  };
}
