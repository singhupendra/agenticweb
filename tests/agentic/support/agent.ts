/**
 * Deterministic scripted "agent" (no LLM): a fixed policy over the REAL MCP surface. It records a trace of every tool call
 * (name, latency, outcome) so scenarios and evals can score discovery, reliability, latency and transaction correctness.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { newKey, toolJson, type Channels, type Json, ORG_SLUG } from "./clients";

export interface TraceStep { tool: string; args: Json; ms: number; ok: boolean; code?: string; attempt: number }
export type Fault = { kind: "fail-before-send" | "drop-response"; tool: string; times: number };
export interface Preferences {
  /** Service picked by comparing the candidates on these criteria. */
  choose: "cheapest" | "shortest" | "longest" | "name";
  name?: string; q?: string; maxPriceMinor?: number; notes?: string; slotIndex?: number;
}
export interface RunResult {
  ok: boolean; reason?: string; trace: TraceStep[]; discovered: string[];
  service?: Json; slot?: Json; booking?: Json; confirmationId?: string; idempotencyKey: string; retries: number; totalMs: number;
}

export class TransientError extends Error {}

/** Wraps `client.callTool` with trace + injected transient faults; retries transient faults with the SAME arguments. */
export function instrument(client: Client, trace: TraceStep[], faults: Fault[] = []) {
  let retries = 0;
  const remaining = faults.map((f) => ({ ...f }));
  return {
    get retries() { return retries; },
    noteRetry() { retries++; },
    async call(name: string, args: Json, o: { retry?: boolean } = {}): Promise<Json> {
      for (let attempt = 1; ; attempt++) {
        const t0 = performance.now();
        const fault = remaining.find((f) => f.tool === name && f.times > 0);
        try {
          if (fault?.kind === "fail-before-send") { fault.times--; throw new TransientError("injected: connection reset before request"); }
          const r = await client.callTool({ name, arguments: args });
          // drop-response only hits a call that actually SUCCEEDED server-side (a committed write whose reply is lost)
          if (fault?.kind === "drop-response" && !r.isError) { fault.times--; trace.push({ tool: name, args, ms: performance.now() - t0, ok: !r.isError, attempt }); throw new TransientError("injected: response lost after server executed"); }
          const out = r.isError ? { error: toolJson(r) } : { data: r.structuredContent as Json };
          trace.push({ tool: name, args, ms: performance.now() - t0, ok: !r.isError, code: r.isError ? toolJson(r).code : undefined, attempt });
          return out;
        } catch (e) {
          if (!(e instanceof TransientError) || attempt >= 4 || o.retry === false) throw e;
          if (!(e as Error).message.includes("response lost")) trace.push({ tool: name, args, ms: performance.now() - t0, ok: false, code: "transient", attempt });
          retries++;
        }
      }
    },
  };
}

/** "Book a consultation": discover → search → details → compare → availability → select → confirm → book → verify status. */
export async function bookConsultation(
  client: Client, ch: Channels, o: { prefs: Preferences; faults?: Fault[]; approve: (confirmationId: string) => Promise<void>; idempotencyKey?: string },
): Promise<RunResult> {
  const trace: TraceStep[] = [];
  const t0 = performance.now();
  const tools = instrument(client, trace, o.faults);
  const idempotencyKey = o.idempotencyKey ?? newKey("agent");
  const res = (partial: Partial<RunResult> & { ok: boolean }): RunResult => ({ trace, discovered: [], idempotencyKey, retries: tools.retries, totalMs: performance.now() - t0, ...partial });

  const listed = await client.listTools();
  const discovered = listed.tools.map((t) => t.name);
  for (const need of ["list_services", "get_service", "list_slots", "create_booking", "get_booking"]) {
    if (!discovered.includes(need)) return res({ ok: false, reason: `tool not discovered: ${need}`, discovered });
  }
  const search = await tools.call("list_services", { orgSlug: ORG_SLUG, ...(o.prefs.q ? { q: o.prefs.q } : {}), ...(o.prefs.maxPriceMinor !== undefined ? { maxPriceMinor: o.prefs.maxPriceMinor } : {}) });
  if (search.error || search.data.items.length === 0) return res({ ok: false, reason: "no matching services", discovered });
  const details: Json[] = [];
  for (const s of search.data.items) {
    const d = await tools.call("get_service", { orgSlug: ORG_SLUG, serviceSlug: s.slug });
    if (d.error) return res({ ok: false, reason: `get_service failed: ${d.error.code}`, discovered });
    details.push(d.data);
  }
  const by = (f: (s: Json) => number) => [...details].sort((a, b) => f(a) - f(b))[0];
  const service =
    o.prefs.choose === "cheapest" ? by((s) => s.priceMinor)
    : o.prefs.choose === "shortest" ? by((s) => s.durationMinutes)
    : o.prefs.choose === "longest" ? by((s) => -s.durationMinutes)
    : details.find((s) => s.name === o.prefs.name);
  if (!service) return res({ ok: false, reason: "no service satisfies the preference", discovered });

  const slots = await tools.call("list_slots", { orgSlug: ORG_SLUG, serviceSlug: service.slug });
  const open = (slots.data?.items ?? []).filter((s: Json) => s.remaining > 0);
  if (open.length === 0) return res({ ok: false, reason: "no available slot", discovered, service });
  const slot = open[Math.min(o.prefs.slotIndex ?? 0, open.length - 1)];

  const args = { orgSlug: ORG_SLUG, slotId: slot.id, ...(o.prefs.notes ? { notes: o.prefs.notes } : {}), idempotencyKey };
  /**
   * A write whose outcome is unknown (response lost) is NEVER blindly re-sent: the agent first reconciles by reading its own
   * bookings (idempotent read). If the booking exists it adopts it; otherwise it retries with the SAME idempotencyKey
   * (and, because approvals are single-use, a fresh human approval).
   */
  const write = async (extra: Json): Promise<Json> => {
    try { return await tools.call("create_booking", { ...args, ...extra }, { retry: false }); }
    catch (e) {
      if (!(e instanceof TransientError)) throw e;
      tools.noteRetry();
      const mine = await tools.call("list_my_bookings", { orgSlug: ORG_SLUG, status: "confirmed", pageSize: 50 });
      const found = mine.data?.items?.find((b: Json) => b.slotId === slot.id);
      return found ? { data: found } : write({});
    }
  };
  let attempt = await write({});
  let confirmationId: string | undefined;
  for (let round = 0; attempt.error?.code === "confirmation_required" && round < 3; round++) {
    confirmationId = attempt.error.confirmationId;
    await o.approve(confirmationId!); // out-of-band: the human, not the agent
    attempt = await write({ confirmationId });
  }
  if (attempt.error) return res({ ok: false, reason: `create_booking: ${attempt.error.code}`, discovered, service, slot, confirmationId });
  const status = await tools.call("get_booking", { orgSlug: ORG_SLUG, bookingId: attempt.data.id });
  if (status.error) return res({ ok: false, reason: `get_booking: ${status.error.code}`, discovered, service, slot, confirmationId });
  return res({ ok: status.data.status === "confirmed", reason: status.data.status === "confirmed" ? undefined : `status ${status.data.status}`, discovered, service, slot, booking: status.data, confirmationId });
}

/** Human approval of the pending confirmation (user bearer token → approve endpoint). */
export const humanApprover = (ch: Channels, userId?: string) => async (confirmationId: string) => {
  const token = await ch.userToken(userId);
  const res = await fetch(`${ch.baseUrl}/api/confirmations/${confirmationId}/approve`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`approve failed ${res.status}: ${await res.text()}`);
};
