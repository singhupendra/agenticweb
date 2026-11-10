/**
 * Actor / Principal: WHO is calling, regardless of channel.
 * Channels (REST/MCP/UI) resolve a request into exactly one Actor; nothing else in the system looks at cookies/headers/tokens.
 */
import { z } from "zod";

export const SCOPES = [
  "services:read",
  "bookings:read",
  "bookings:write",
  "profile:read",
] as const;
export type Scope = (typeof SCOPES)[number];
export const ScopeSchema = z.enum(SCOPES);

/** A user-consented, revocable, expiring grant to an agent client. */
export interface Delegation {
  grantId: string;
  scopes: readonly Scope[];
  /** ISO-8601; the policy rejects expired grants. */
  expiresAt: string;
  /** MCP/REST resource the token was minted for (RFC 8707); checked at token verification. */
  audience?: string;
}

export interface AnonymousActor {
  kind: "anonymous";
}
export interface UserActor {
  kind: "user";
  userId: string;
  organizationId: string;
}
export interface AdminActor {
  kind: "admin";
  userId: string;
  organizationId: string;
}
export interface AgentActor {
  kind: "agent";
  /** OAuth client / agent identity. */
  clientId: string;
  /** The human the agent acts for. null = public-only agent (no user data). */
  onBehalfOf: { userId: string; organizationId: string } | null;
  delegation: Delegation;
}

export type Actor = AnonymousActor | UserActor | AdminActor | AgentActor;

export const ANONYMOUS: AnonymousActor = Object.freeze({ kind: "anonymous" });

/** The user whose data this actor may touch; null for anonymous / public-only agents. */
export function effectiveUserId(actor: Actor): string | null {
  switch (actor.kind) {
    case "user":
    case "admin":
      return actor.userId;
    case "agent":
      return actor.onBehalfOf?.userId ?? null;
    default:
      return null;
  }
}

export function actorOrganizationId(actor: Actor): string | null {
  switch (actor.kind) {
    case "user":
    case "admin":
      return actor.organizationId;
    case "agent":
      return actor.onBehalfOf?.organizationId ?? null;
    default:
      return null;
  }
}

/** Stable subject string for audit and idempotency scoping. */
export function actorSubject(actor: Actor): string {
  switch (actor.kind) {
    case "anonymous":
      return "anonymous";
    case "user":
    case "admin":
      return `${actor.kind}:${actor.userId}`;
    case "agent":
      return `agent:${actor.clientId}:${actor.onBehalfOf?.userId ?? "-"}:${actor.delegation.grantId}`;
  }
}

/** Channel adapters implement this; the result is the ONLY identity input to capabilities. */
export interface ActorResolver {
  resolve(request: Request): Promise<Actor>;
}
