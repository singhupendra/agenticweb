/**
 * Audit-log contract. Recorded for every mutating capability AND every denied call, in every channel.
 * Append-only. Must never contain raw input (store inputHash) or PII.
 */
import { createHash } from "node:crypto";
import type { Actor } from "../auth/actor";
import { actorSubject } from "../auth/actor";

export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEvent {
  occurredAt: string;
  requestId: string;
  capability: string;
  outcome: AuditOutcome;
  actor: { kind: Actor["kind"]; subject: string; onBehalfOf?: string | null; grantId?: string; clientId?: string };
  organizationId?: string | null;
  resource?: { type: string; id?: string };
  inputHash?: string;
  detail?: Record<string, unknown>;
}

export interface AuditLog {
  record(event: AuditEvent): Promise<void>;
}

export function actorForAudit(actor: Actor): AuditEvent["actor"] {
  const base = { kind: actor.kind, subject: actorSubject(actor) };
  if (actor.kind === "agent") {
    return { ...base, clientId: actor.clientId, grantId: actor.delegation.grantId, onBehalfOf: actor.onBehalfOf?.userId ?? null };
  }
  return base;
}

/** Stable JSON (sorted keys) so equal payloads hash equally. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
export const hashInput = (v: unknown): string => createHash("sha256").update(stableStringify(v)).digest("hex");

export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
