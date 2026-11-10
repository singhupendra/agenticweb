/**
 * Agent-facing metrics. Call the `record*` helpers from the REST/MCP layers; the executor hook (telemetry.ts) already
 * records invocation, latency, invalid-argument, authz and task metrics for every capability call.
 *
 * Cardinality rules: attribute values are bounded enums or registry capability names. Never pass user ids, emails,
 * request ids, tokens or free text — the helpers only copy their declared keys, so extra properties are dropped.
 * With no SDK registered every call is a no-op. Prometheus names: see docs/observability.md.
 */
import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

export const METRIC_NAMES = {
  agentRequests: "agenticweb.agent.requests",
  toolDiscoveries: "agenticweb.agent.tool_discoveries",
  toolInvocations: "agenticweb.agent.tool_invocations",
  toolDuration: "agenticweb.agent.tool_duration",
  invalidArguments: "agenticweb.agent.invalid_arguments",
  authzRejections: "agenticweb.agent.authz_rejections",
  taskCompletions: "agenticweb.agent.task_completions",
  humanInterventions: "agenticweb.agent.human_interventions",
} as const;

export type Channel = "rest" | "mcp" | "ui" | "webmcp";
export type ActorKind = "anonymous" | "user" | "admin" | "agent";
export type InvocationOutcome = "success" | "invalid_argument" | "authz_rejected" | "conflict" | "rate_limited" | "error";
export type TaskOutcome = "completed" | "failed" | "abandoned";
export type InterventionReason = "confirmation_required" | "consent_required" | "escalation" | "manual_override";

const meter = () => metrics.getMeter("agenticweb");
const instruments = new Map<string, Counter | Histogram>();
function counter(name: string, description: string): Counter {
  let c = instruments.get(name) as Counter | undefined;
  if (!c) instruments.set(name, (c = meter().createCounter(name, { description })));
  return c;
}
function histogram(name: string, description: string): Histogram {
  let h = instruments.get(name) as Histogram | undefined;
  if (!h) {
    h = meter().createHistogram(name, { description, unit: "ms", advice: { explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] } });
    instruments.set(name, h);
  }
  return h;
}

export function recordAgentRequest(a: { channel: Channel; actorKind: ActorKind }): void {
  counter(METRIC_NAMES.agentRequests, "Requests received through an agent-capable channel").add(1, { channel: a.channel, actor_kind: a.actorKind });
}
export function recordToolDiscovery(a: { channel: Channel; outcome: "success" | "error" }): void {
  counter(METRIC_NAMES.toolDiscoveries, "Tool/capability discovery requests (tools/list, OpenAPI, llms.txt)").add(1, { channel: a.channel, outcome: a.outcome });
}
export function recordToolInvocation(a: { tool: string; actorKind: ActorKind; outcome: InvocationOutcome; durationMs: number }): void {
  const attrs = { tool: a.tool, actor_kind: a.actorKind, outcome: a.outcome };
  counter(METRIC_NAMES.toolInvocations, "Tool/capability invocations by outcome").add(1, attrs);
  histogram(METRIC_NAMES.toolDuration, "Tool/capability invocation latency").record(a.durationMs, attrs);
}
export function recordInvalidArgument(a: { tool: string }): void {
  counter(METRIC_NAMES.invalidArguments, "Invocations rejected by input validation").add(1, { tool: a.tool });
}
export function recordAuthzRejection(a: { tool: string; code: string }): void {
  counter(METRIC_NAMES.authzRejections, "Invocations rejected by authentication/authorization").add(1, { tool: a.tool, code: a.code });
}
export function recordTaskCompletion(a: { task: string; outcome: TaskOutcome }): void {
  counter(METRIC_NAMES.taskCompletions, "Agent tasks (state-changing capability calls) by outcome").add(1, { task: a.task, outcome: a.outcome });
}
export function recordHumanIntervention(a: { reason: InterventionReason }): void {
  counter(METRIC_NAMES.humanInterventions, "Times a human had to confirm, consent or take over").add(1, { reason: a.reason });
}
