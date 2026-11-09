import { ANONYMOUS, ScopeSchema, type Actor, type ActorResolver } from "./actor";

/**
 * DEV/TEST ONLY. Parses `x-dev-actor`:
 *   user|<userId>|<orgId>  admin|<userId>|<orgId>  agent|<clientId>|<userId or ->|<orgId or ->|<scope,scope>
 * Constructing it in production throws. Real resolvers arrive in Phase 3.
 */
export class DevHeaderActorResolver implements ActorResolver {
  constructor(
    private readonly opts: { enabled: boolean; nodeEnv: string; now?: () => Date },
  ) {
    if (opts.nodeEnv === "production") throw new Error("DevHeaderActorResolver cannot be used in production");
  }

  async resolve(request: Request): Promise<Actor> {
    if (!this.opts.enabled) return ANONYMOUS;
    const raw = request.headers.get("x-dev-actor");
    if (!raw) return ANONYMOUS;
    const [kind, a, b, c, d] = raw.split("|");
    if ((kind === "user" || kind === "admin") && a && b) return { kind, userId: a, organizationId: b };
    if (kind === "agent" && a) {
      const scopes = (d ?? "").split(",").filter(Boolean).map((s) => ScopeSchema.parse(s));
      const now = this.opts.now?.() ?? new Date();
      return {
        kind: "agent",
        clientId: a,
        onBehalfOf: b && b !== "-" && c && c !== "-" ? { userId: b, organizationId: c } : null,
        delegation: { grantId: "dev-grant", scopes, expiresAt: new Date(now.getTime() + 3600_000).toISOString() },
      };
    }
    return ANONYMOUS;
  }
}
