/**
 * Deterministic evaluation (no LLM, CI-safe). Runs the FIXED dataset against the real app + isolated Postgres through the MCP SDK
 * client. Every task is reported — failures are never dropped. Exit code 1 if a quality gate is missed.
 *   pnpm eval            → prints the report, writes evals/results/deterministic-latest.{json,md}
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bookConsultation, humanApprover } from "../tests/agentic/support/agent";
import { startApp } from "../tests/agentic/support/app";
import { CUSTOMER_ID, ORG_ID, ORG_SLUG, OTHER_ID, Channels, newKey, toolJson, type Json } from "../tests/agentic/support/clients";
import { createIsolatedDb, dropIsolatedDb } from "../tests/agentic/support/test-db";
import { gate, loadDataset, renderReport, summarize, type Task, type TaskResult } from "./lib";

type McpClient = Awaited<ReturnType<Channels["mcp"]>>;
const base = (t: Task): Pick<TaskResult, "id" | "category"> => ({ id: t.id, category: t.category });

async function runBookOrRecover(ch: Channels, t: Task): Promise<TaskResult> {
  const before = await ch.bookingCount();
  const t0 = performance.now();
  const client = await ch.mcp(await ch.agentToken());
  const run = await bookConsultation(client, ch, { prefs: t.prefs!, faults: t.faults, approve: humanApprover(ch) });
  const toolCalls = run.trace.map((s) => ({ tool: s.tool, ms: s.ms, ok: s.ok, code: s.code }));
  const fail: string[] = [];
  if (!run.ok) fail.push(run.reason ?? "agent did not complete");
  // ---- transaction correctness from Postgres, independent of what the agent claims ----
  let correct = false;
  if (run.booking) {
    const rows = await ch.bookingsFor(CUSTOMER_ID);
    const row = rows.find((b) => b.id === run.booking.id);
    const [svc] = row ? await ch.sql(`SELECT slug FROM "Service" WHERE id=$1`, [row.serviceId]) : [];
    const checks = {
      exists: !!row, confirmed: row?.status === "confirmed", owner: row?.userId === CUSTOMER_ID,
      service: svc?.slug === t.expect.service, slot: row?.slotId === run.slot?.id,
      notes: (row?.notes ?? undefined) === t.expect.notes, onlyOneOnSlot: (await ch.activeBookingsOnSlot(run.slot.id)).length === 1,
      exactlyOneNew: (await ch.bookingCount()) === before + 1,
    };
    correct = Object.values(checks).every(Boolean);
    for (const [k, v] of Object.entries(checks)) if (!v) fail.push(`db check failed: ${k}`);
  } else if ((await ch.bookingCount()) !== before) fail.push("state changed although the agent reported no booking");
  if (t.category === "recovery" && run.retries < 1) fail.push("injected fault never exercised");
  return { ...base(t), success: fail.length === 0, failure: fail.join("; ") || undefined, transactionCorrect: correct, retries: run.retries, toolCalls, totalMs: performance.now() - t0 };
}

/** One hostile action. Returns what happened so the caller can judge both the rejection and the (unchanged) state. */
async function attack(ch: Channels, kind: string): Promise<{ rejected: boolean; detail: string }> {
  const txt = (r: Json) => toolJson(r);
  const approve = humanApprover(ch);
  const slot = await ch.freshSlot("quick-consult");
  const args = (extra: Json = {}) => ({ orgSlug: ORG_SLUG, slotId: slot.id, idempotencyKey: newKey("eval"), confirm: true, ...extra });
  /** Run a write to its end, approving the gate as the human would; resolves to the final outcome. */
  const drive = async (c: McpClient, a: Json, approver = CUSTOMER_ID): Promise<{ ok: boolean; code?: string }> => {
    let r = await c.callTool({ name: "create_booking", arguments: a }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ code: "protocol", detail: e.message }) }] }));
    if (r.isError && txt(r).code === "confirmation_required") { await humanApprover(ch, approver)(txt(r).confirmationId); r = await c.callTool({ name: "create_booking", arguments: { ...a, confirmationId: txt(r).confirmationId } }); }
    return r.isError ? { ok: false, code: txt(r).code } : { ok: true };
  };
  void approve;
  switch (kind) {
    case "anonymous-book": { const r = await ch.mcpRaw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_booking", arguments: args() } }); return { rejected: r.status === 401, detail: `HTTP ${r.status}` }; }
    case "readonly-agent-book": { const r = await drive(await ch.mcp(await ch.agentToken(["services:read"])), args()); return { rejected: !r.ok, detail: r.code ?? "executed" }; }
    case "public-only-book": { const r = await drive(await ch.mcp(await ch.mint({ kind: "agent", scopes: ["bookings:write", "bookings:read", "services:read"], resource: "mcp" })), args()); return { rejected: !r.ok, detail: r.code ?? "executed" }; }
    case "no-human-approval": { const c = await ch.mcp(await ch.agentToken()); const r = await c.callTool({ name: "create_booking", arguments: args() }); return { rejected: !!r.isError && txt(r).code === "confirmation_required", detail: txt(r).code }; }
    case "wrong-audience": { const t = await ch.mint({ kind: "agent", userId: CUSTOMER_ID, organizationId: ORG_ID, scopes: ["services:read"], resource: "rest" }); const r = await ch.mcpRaw({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${t}` }); return { rejected: r.status === 401, detail: `HTTP ${r.status}` }; }
    case "identity-fields": { const r = await drive(await ch.mcp(await ch.agentToken()), args({ userId: OTHER_ID, status: "confirmed" })); return { rejected: !r.ok, detail: r.code ?? "executed" }; }
    case "past-slot": { const past = await ch.pastSlot("quick-consult"); const r = await drive(await ch.mcp(await ch.agentToken()), args({ slotId: past })); return { rejected: !r.ok, detail: r.code ?? "executed" }; }
    case "idor-read": case "idor-cancel": {
      const mine = (await ch.rest("POST", "/bookings", { token: await ch.userToken(CUSTOMER_ID), body: { slotId: slot.id }, headers: { "idempotency-key": newKey("eval") } })).body.data;
      await ch.ensureOtherUser();
      const c = await ch.mcp(await ch.agentToken(["bookings:read", "bookings:write"], OTHER_ID));
      if (kind === "idor-read") { const r = await c.callTool({ name: "get_booking", arguments: { orgSlug: ORG_SLUG, bookingId: mine.id } }); return { rejected: !!r.isError && txt(r).code === "not_found", detail: txt(r).code ?? "returned data" }; }
      let r = await c.callTool({ name: "cancel_booking", arguments: { orgSlug: ORG_SLUG, bookingId: mine.id, idempotencyKey: newKey("eval"), confirm: true } });
      if (r.isError && txt(r).code === "confirmation_required") { await humanApprover(ch, OTHER_ID)(txt(r).confirmationId); r = await c.callTool({ name: "cancel_booking", arguments: { orgSlug: ORG_SLUG, bookingId: mine.id, idempotencyKey: newKey("eval"), confirm: true, confirmationId: txt(r).confirmationId } }); }
      const still = (await ch.bookingsFor(CUSTOMER_ID)).find((b) => b.id === mine.id)!.status === "confirmed";
      return { rejected: !!r.isError && still, detail: `${txt(r).code}; booking ${still ? "intact" : "CANCELLED"}` };
    }
    case "self-approve": {
      const agentTok = await ch.agentToken();
      const c = await ch.mcp(agentTok);
      const p = txt(await c.callTool({ name: "create_booking", arguments: args() }));
      const restAgent = await ch.agentToken(["bookings:write"], CUSTOMER_ID, { resource: "rest" });
      const res = await fetch(`${ch.baseUrl}/api/confirmations/${p.confirmationId}/approve`, { method: "POST", headers: { authorization: `Bearer ${restAgent}` } });
      const retry = await c.callTool({ name: "create_booking", arguments: args({ idempotencyKey: undefined, confirmationId: p.confirmationId }) });
      return { rejected: res.status >= 400 && !!retry.isError, detail: `approve HTTP ${res.status}` };
    }
    default: throw new Error(`unknown attack ${kind}`);
  }
}

async function runAuthz(ch: Channels, t: Task): Promise<TaskResult> {
  const before = await ch.bookingCount();
  const t0 = performance.now();
  const beforeStatuses = JSON.stringify(await ch.sql(`SELECT id,status FROM "Booking" ORDER BY id`));
  const out = await attack(ch, t.attack!);
  const afterRows = await ch.sql(`SELECT id,status FROM "Booking" ORDER BY id`);
  // The IDOR setup legitimately creates one booking for the victim; everything else must leave state untouched.
  const created = t.attack?.startsWith("idor") ? 1 : 0;
  const stateUnchanged = (await ch.bookingCount()) === before + created && (created ? true : JSON.stringify(afterRows) === beforeStatuses);
  const ok = out.rejected && stateUnchanged;
  return { ...base(t), success: ok, failure: ok ? undefined : `${out.rejected ? "" : "NOT REJECTED"}${stateUnchanged ? "" : " STATE CHANGED"} (${out.detail})`, transactionCorrect: null, retries: 0, toolCalls: [], totalMs: performance.now() - t0 };
}

async function runDiscovery(ch: Channels, t: Task): Promise<TaskResult> {
  const t0 = performance.now();
  const names = (await (await ch.mcp(await ch.agentToken(t.scopes))).listTools()).tools.map((x) => x.name);
  const want = t.expect.tools ?? [];
  const found = want.filter((n) => names.includes(n));
  const leaked = (t.expect.absent ?? []).filter((n) => names.includes(n));
  const ok = found.length === want.length && leaked.length === 0;
  return { ...base(t), success: ok, discovery: want.length ? found.length / want.length : 1, failure: ok ? undefined : `missing ${want.filter((n) => !names.includes(n))} leaked ${leaked}`, transactionCorrect: null, retries: 0, toolCalls: [], totalMs: performance.now() - t0 };
}

async function main() {
  const dataset = loadDataset();
  const dbUrl = process.env.QA_DATABASE_URL ?? (await createIsolatedDb());
  const ownDb = !process.env.QA_DATABASE_URL;
  const app = await startApp(dbUrl);
  try {
    const ch = new Channels(app.baseUrl, dbUrl);
    for (const p of ["/api/health", "/openapi.json"]) await fetch(`${app.baseUrl}${p}`);
    await (await ch.mcp()).listTools(); // warm-up (dev-mode compile) — excluded from scoring
    const results: TaskResult[] = [];
    for (const t of dataset.tasks) {
      try {
        results.push(t.category === "authz" ? await runAuthz(ch, t) : t.category === "discovery" ? await runDiscovery(ch, t) : await runBookOrRecover(ch, t));
      } catch (e) {
        // A crash is a FAILED task, never a skipped one.
        results.push({ ...base(t), success: false, failure: `crashed: ${(e as Error).message}`, transactionCorrect: t.category === "book" || t.category === "recovery" ? false : null, retries: 0, toolCalls: [], totalMs: 0 });
      }
    }
    const summary = summarize(results);
    const md = renderReport(`Deterministic eval — ${dataset.dataset} v${dataset.version}`, summary, results);
    const dir = fileURLToPath(new URL("./results/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}deterministic-latest.json`, JSON.stringify({ dataset: dataset.version, ranAt: new Date().toISOString(), summary, results }, null, 2));
    writeFileSync(`${dir}deterministic-latest.md`, md);
    console.log(md);
    const missed = gate(summary);
    if (missed.length) { console.error(`\nQUALITY GATE FAILED: ${missed.join("; ")}`); process.exitCode = 1; }
    else console.log("\nQuality gates passed (success ≥ 95%, authorization safety 100%, transaction correctness 100%).");
  } finally {
    await app.stop();
    if (ownDb) await dropIsolatedDb(dbUrl);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
