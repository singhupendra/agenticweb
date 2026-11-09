import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ANONYMOUS } from "@/core/auth";
import { createExecutor, createRegistry, defineCapability } from "@/core/capabilities";
import { DefaultPolicy } from "@/core/authorization";
import { InMemoryIdempotencyStore } from "@/core/idempotency";
import { InMemoryAuditLog, nullLogger, hashInput } from "@/core/logging";
import { NOW, ORG_ID, USER_ID, agent, user } from "./fixtures";

type Deps = { counter: { n: number } };
const note = defineCapability({
  name: "notes.create",
  summary: "test mutation",
  input: z.strictObject({ text: z.string().min(1) }),
  output: z.object({ id: z.number() }),
  requirement: { access: "authenticated", scope: "bookings:write" },
  mutating: true,
  http: { method: "POST", path: "/api/notes" },
  mcp: { toolName: "create_note", exposed: true },
  execute: async (ctx: { deps: Deps }) => ({ id: ++ctx.deps.counter.n, secret: "leak" }),
});
const owned = defineCapability({
  name: "notes.get",
  summary: "owner read",
  input: z.strictObject({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  requirement: { access: "owner-or-admin", scope: "bookings:read" },
  mutating: false,
  http: { method: "GET", path: "/api/notes/{id}" },
  mcp: { toolName: "get_note", exposed: true },
  loadResource: async (_c, i) => (i.id === "missing" ? null : { type: "note", id: i.id, ownerId: USER_ID, organizationId: ORG_ID }),
  execute: async () => ({ ok: true }),
});

function setup() {
  const deps: Deps = { counter: { n: 0 } };
  const audit = new InMemoryAuditLog();
  const executor = createExecutor<Deps>({
    registry: createRegistry<Deps>([note, owned]),
    policy: new DefaultPolicy(() => NOW), audit, idempotency: new InMemoryIdempotencyStore(() => NOW.getTime()),
    logger: nullLogger, deps, clock: () => NOW,
  });
  return { deps, audit, executor };
}
const KEY = "key-12345678";

describe("registry validation", () => {
  const base = { ...note };
  it("rejects duplicates", () => expect(() => createRegistry([note, note])).toThrow(/Duplicate/));
  it("rejects mutating GET", () => expect(() => createRegistry([{ ...base, http: { method: "GET", path: "/x" } }])).toThrow(/cannot use GET/));
  it("rejects admin caps exposed to MCP", () =>
    expect(() => createRegistry([{ ...base, requirement: { access: "admin", scope: "bookings:write" } }])).toThrow(/Admin/));
  it("rejects owner-or-admin without loadResource", () =>
    expect(() => createRegistry([{ ...owned, loadResource: undefined }])).toThrow(/loadResource/));
  it("matches http routes and extracts params", () => {
    const m = createRegistry([owned]).matchHttp("GET", "/api/notes/abc%20d");
    expect(m?.capability.name).toBe("notes.get");
    expect(m?.params).toEqual({ id: "abc d" });
  });
});

describe("executor pipeline", () => {
  it("validates input strictly (no mass assignment)", async () => {
    const { executor } = setup();
    await expect(executor.invoke("notes.create", user, { text: "x", userId: "evil" }, { idempotencyKey: KEY })).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("authorizes before executing and audits the denial", async () => {
    const { executor, audit, deps } = setup();
    await expect(executor.invoke("notes.create", ANONYMOUS, { text: "x" }, { idempotencyKey: KEY })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(deps.counter.n).toBe(0);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ outcome: "denied", capability: "notes.create", actor: { kind: "anonymous" } });
  });
  it("requires an idempotency key for mutations", async () => {
    const { executor } = setup();
    await expect(executor.invoke("notes.create", user, { text: "x" })).rejects.toMatchObject({ code: "idempotency_key_required" });
  });
  it("replays the stored result for the same key + payload without re-executing", async () => {
    const { executor, deps, audit } = setup();
    const a = await executor.invoke("notes.create", user, { text: "x" }, { idempotencyKey: KEY });
    const b = await executor.invoke("notes.create", user, { text: "x" }, { idempotencyKey: KEY });
    expect(a.data).toEqual({ id: 1 });
    expect(b.data).toEqual({ id: 1 });
    expect(deps.counter.n).toBe(1);
    expect(audit.events.filter((e) => e.outcome === "success")).toHaveLength(1);
  });
  it("rejects key reuse with a different payload", async () => {
    const { executor } = setup();
    await executor.invoke("notes.create", user, { text: "x" }, { idempotencyKey: KEY });
    await expect(executor.invoke("notes.create", user, { text: "y" }, { idempotencyKey: KEY })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
  });
  it("scopes keys per actor", async () => {
    const { executor, deps } = setup();
    await executor.invoke("notes.create", user, { text: "x" }, { idempotencyKey: KEY });
    await executor.invoke("notes.create", agent(["bookings:write"]), { text: "x" }, { idempotencyKey: KEY });
    expect(deps.counter.n).toBe(2);
  });
  it("strips undeclared output fields", async () => {
    const { executor } = setup();
    const r = await executor.invoke("notes.create", user, { text: "x" }, { idempotencyKey: KEY });
    expect(JSON.stringify(r)).not.toContain("leak");
  });
  it("audit entries store a hash, never raw input", async () => {
    const { executor, audit } = setup();
    await executor.invoke("notes.create", user, { text: "secret text" }, { idempotencyKey: KEY });
    expect(audit.events[0]?.inputHash).toBe(hashInput({ text: "secret text" }));
    expect(JSON.stringify(audit.events)).not.toContain("secret text");
  });
  it("delegated agent without scope is forbidden; non-owner gets 404; missing resource 404", async () => {
    const { executor } = setup();
    await expect(executor.invoke("notes.get", agent(["services:read"]), { id: "1" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(executor.invoke("notes.get", { ...user, userId: "66666666-6666-4666-8666-666666666666" }, { id: "1" })).rejects.toMatchObject({ code: "not_found" });
    await expect(executor.invoke("notes.get", user, { id: "missing" })).rejects.toMatchObject({ code: "not_found" });
    expect((await executor.invoke("notes.get", user, { id: "1" }, { requestId: "rid" })).meta.requestId).toBe("rid");
  });
  it("unknown capability is 404", async () => {
    await expect(setup().executor.invoke("nope.nope", user, {})).rejects.toMatchObject({ code: "not_found" });
  });
});
