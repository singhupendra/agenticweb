/**
 * OPTIONAL model-dependent evaluation. Requires ANTHROPIC_API_KEY (costs real money) — otherwise it exits 0 with a clear SKIPPED
 * notice and writes NOTHING (no fabricated results). Never part of CI.
 *   ANTHROPIC_API_KEY=… pnpm eval:llm            # EVAL_MODEL (default claude-sonnet-5-5), EVAL_LIMIT=<n> to cap tasks
 *   EVAL_PRICE_IN_PER_MTOK / EVAL_PRICE_OUT_PER_MTOK (USD) → enables cost in USD; otherwise only tokens are reported.
 * Scope: all `book` and `recovery` tasks of the fixed dataset (the model has to find tools, compare, select, book). Failures are kept.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { humanApprover } from "../tests/agentic/support/agent";
import { startApp } from "../tests/agentic/support/app";
import { CUSTOMER_ID, ORG_SLUG, Channels } from "../tests/agentic/support/clients";
import { createIsolatedDb, dropIsolatedDb } from "../tests/agentic/support/test-db";
import { anthropicComplete, runLlmAgent, type LlmHooks } from "./llm-agent";
import { loadDataset, renderReport, summarize, type Task, type TaskResult } from "./lib";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log("SKIPPED: ANTHROPIC_API_KEY is not set. The LLM evaluation is optional and model-dependent; no results were produced or faked.");
  process.exit(0);
}

const model = process.env.EVAL_MODEL ?? "claude-sonnet-5-5";
const faultHooks = (t: Task, ch: Channels): LlmHooks => {
  const remaining = (t.faults ?? []).map((f) => ({ ...f }));
  return {
    onConfirmation: humanApprover(ch),
    intercept: async (tool, _args, execute) => {
      const f = remaining.find((x) => x.tool === tool && x.times > 0);
      if (!f) return undefined;
      if (f.kind === "fail-before-send") { f.times--; return "Network error: connection reset before the request was sent."; }
      const r = (await execute()) as { isError?: boolean };
      if (r.isError) return undefined; // only a committed write can have its reply lost
      f.times--;
      return "Network error: the connection was lost while waiting for the response. The outcome is unknown.";
    },
  };
};

async function main() {
  const dataset = loadDataset();
  const tasks = dataset.tasks.filter((t) => t.category === "book" || t.category === "recovery").slice(0, Number(process.env.EVAL_LIMIT ?? 1e9));
  const dbUrl = await createIsolatedDb();
  const app = await startApp(dbUrl);
  try {
    const ch = new Channels(app.baseUrl, dbUrl);
    await fetch(`${app.baseUrl}/api/health`);
    const complete = anthropicComplete(key!, model);
    const results: TaskResult[] = [];
    for (const t of tasks) {
      const before = await ch.bookingCount();
      const beforeMine = (await ch.bookingsFor(CUSTOMER_ID)).length;
      const t0 = performance.now();
      try {
        const run = await runLlmAgent({ complete, mcp: await ch.mcp(await ch.agentToken()), goal: t.goal, orgSlug: ORG_SLUG, hooks: faultHooks(t, ch) });
        const rows = (await ch.bookingsFor(CUSTOMER_ID)).slice(beforeMine);
        const created = (await ch.bookingCount()) - before;
        const mine = rows.at(-1);
        const [svc] = mine ? await ch.sql(`SELECT slug FROM "Service" WHERE id=$1`, [mine.serviceId]) : [];
        // `notes` are checked only where the task asked for them; the model must not invent a different outcome.
        const correct = created === 1 && mine?.status === "confirmed" && svc?.slug === t.expect.service && (t.expect.notes === undefined || mine?.notes === t.expect.notes);
        results.push({ id: t.id, category: t.category, success: correct, transactionCorrect: correct, failure: correct ? undefined : `bookings created=${created}, service=${svc?.slug ?? "none"}, status=${mine?.status ?? "none"}; model said: ${run.finalText.slice(0, 160)}`, retries: 0, toolCalls: run.toolCalls, totalMs: performance.now() - t0, tokens: { input: run.tokens.input, output: run.tokens.output } });
      } catch (e) {
        results.push({ id: t.id, category: t.category, success: false, transactionCorrect: false, failure: `crashed: ${(e as Error).message}`, retries: 0, toolCalls: [], totalMs: performance.now() - t0 });
      }
    }
    const s = summarize(results);
    const pin = Number(process.env.EVAL_PRICE_IN_PER_MTOK), pout = Number(process.env.EVAL_PRICE_OUT_PER_MTOK);
    const usd = pin >= 0 && pout >= 0 && process.env.EVAL_PRICE_IN_PER_MTOK ? (s.cost.inputTokens * pin + s.cost.outputTokens * pout) / 1e6 : undefined;
    let md = renderReport(`LLM eval (model-dependent) — ${model} — dataset v${dataset.version}`, s, results);
    if (usd !== undefined) md += `\n\nEstimated cost: $${usd.toFixed(4)} (prices from EVAL_PRICE_* env)`;
    const dir = fileURLToPath(new URL("./results/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}llm-latest.json`, JSON.stringify({ model, dataset: dataset.version, ranAt: new Date().toISOString(), summary: s, results }, null, 2));
    writeFileSync(`${dir}llm-latest.md`, md);
    console.log(md);
  } finally { await app.stop(); await dropIsolatedDb(dbUrl); }
}
main().catch((e) => { console.error(e); process.exit(1); });
