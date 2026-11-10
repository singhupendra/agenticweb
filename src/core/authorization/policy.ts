/**
 * Authorization contract. Every capability declares a Requirement; the policy decides.
 * Routes/tools/UI NEVER make authorization decisions themselves.
 */
import { actorOrganizationId, effectiveUserId, type Actor, type Scope } from "../auth/actor";
import { bearerChallenge } from "../auth/challenge";
import { AppError, forbidden, notFound, unauthenticated } from "../errors";

export type Access =
  | "public" //            anyone (agents still need the scope, if one is declared)
  | "authenticated" //     user/admin, or agent delegated by a user
  | "owner-or-admin" //    resource.ownerId === effective user, or admin
  | "admin"; //            human admins only. Agents are NEVER admin.

export interface Requirement {
  access: Access;
  /** Scope an agent's delegation must contain. Required for any capability exposed to agents. */
  scope?: Scope;
}

/** Facts about the target resource, supplied by the capability's `loadResource` (never by the caller). */
export interface ResourceRef {
  type: string;
  id?: string;
  organizationId?: string;
  ownerId?: string;
}

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: string; kind: "unauthenticated" | "forbidden" | "not_found"; /** set when denied for a missing scope */ scope?: Scope };

export interface AuthorizationPolicy {
  decide(actor: Actor, requirement: Requirement, resource?: ResourceRef): Decision;
}

export const allow: Decision = { allowed: true };

/** Convert a denial into the AppError a channel should return. */
export function enforce(decision: Decision): void {
  if (decision.allowed) return;
  if (decision.kind === "unauthenticated") throw unauthenticated();
  if (decision.kind === "not_found") throw notFound(); // hide existence (IDOR)
  if (decision.scope) {
    // RFC 6750 §3.1 / MCP: 403 + insufficient_scope naming the scope(s) needed. Adapters append resource_metadata.
    throw new AppError("forbidden", "The token does not carry the scope required for this action.", {
      headers: { "www-authenticate": bearerChallenge({ error: "insufficient_scope", scope: decision.scope }) },
    });
  }
  throw forbidden();
}

export function isAuthzError(e: unknown): e is AppError {
  return e instanceof AppError && (e.code === "forbidden" || e.code === "unauthenticated" || e.code === "not_found");
}

export class DefaultPolicy implements AuthorizationPolicy {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  decide(actor: Actor, req: Requirement, resource?: ResourceRef): Decision {
    // 1. Agent delegation: must be unexpired and carry the required scope.
    if (actor.kind === "agent") {
      if (new Date(actor.delegation.expiresAt).getTime() <= this.clock().getTime()) {
        return { allowed: false, kind: "unauthenticated", reason: "delegation expired" };
      }
      if (req.scope && !actor.delegation.scopes.includes(req.scope)) {
        return { allowed: false, kind: "forbidden", reason: `missing scope ${req.scope}`, scope: req.scope };
      }
      if (req.access === "admin") return { allowed: false, kind: "forbidden", reason: "agents are never admin" };
    }

    if (req.access === "public") return allow;

    // 2. Authentication
    const userId = effectiveUserId(actor);
    if (actor.kind === "anonymous" || userId === null) {
      return { allowed: false, kind: "unauthenticated", reason: "no user identity" };
    }

    // 3. Tenant isolation: a resource from another organization does not exist for this actor.
    const actorOrg = actorOrganizationId(actor);
    if (resource?.organizationId && actorOrg && resource.organizationId !== actorOrg) {
      return { allowed: false, kind: "not_found", reason: "cross-organization access" };
    }

    switch (req.access) {
      case "authenticated":
        return allow;
      case "admin":
        return actor.kind === "admin" ? allow : { allowed: false, kind: "forbidden", reason: "admin required" };
      case "owner-or-admin":
        if (actor.kind === "admin") return allow;
        if (resource?.ownerId && resource.ownerId === userId) return allow;
        // Non-owner: pretend it doesn't exist (IDOR defence).
        return { allowed: false, kind: "not_found", reason: "not owner" };
    }
  }
}
