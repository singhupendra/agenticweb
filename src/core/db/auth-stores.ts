/**
 * Postgres-backed security stores behind the existing interfaces, so state is shared by every instance and survives restarts:
 *   GrantStore · ConfirmationStore (human approvals) · RateLimitStore · ReplayGuard.
 * Atomicity comes from single SQL statements (INSERT .. ON CONFLICT, conditional UPDATE), never read-modify-write in JS.
 * Failure policy: a database error PROPAGATES (→ 5xx). Security stores never "fail open".
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { Confirmation, ConfirmationStatus, ConfirmationStore } from "@/agents/policies/confirmation";
import { ScopeSchema, type Grant, type GrantStore } from "../auth";
import { AppError, conflict } from "../errors";
import type { RateLimitStore } from "../security/rate-limit";
import type { ReplayGuard } from "../security/replay";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PrismaGrantStore implements GrantStore {
  constructor(private readonly db: PrismaClient) {}

  async get(grantId: string): Promise<Grant | null> {
    const g = await this.db.agentGrant.findUnique({ where: { grantId } });
    if (!g) return null;
    return {
      grantId: g.grantId, userId: g.userId, clientId: g.clientId,
      scopes: g.scopes.flatMap((s) => { const r = ScopeSchema.safeParse(s); return r.success ? [r.data] : []; }), // unknown scopes grant nothing
      revokedAt: g.revokedAt?.toISOString() ?? null,
    };
  }

  /** Create or re-scope a grant of the SAME user+client. A revoked grant is never resurrected; ownership never changes. */
  async put(g: Grant): Promise<void> {
    const rows = await this.db.$queryRaw<{ grantId: string }[]>`
      INSERT INTO "AgentGrant" ("grantId","userId","clientId","scopes") VALUES (${g.grantId}, ${g.userId}, ${g.clientId}, ${[...g.scopes]}::text[])
      ON CONFLICT ("grantId") DO UPDATE SET "scopes" = EXCLUDED."scopes"
      WHERE "AgentGrant"."userId" = EXCLUDED."userId" AND "AgentGrant"."clientId" = EXCLUDED."clientId" AND "AgentGrant"."revokedAt" IS NULL
      RETURNING "grantId"`;
    if (rows.length === 0) throw conflict("Grant already exists for another owner/client or was revoked.");
  }

  /** true when this call revoked it; false when unknown or already revoked (the first revocation time is kept). */
  async revoke(grantId: string, at: Date = new Date()): Promise<boolean> {
    return (await this.db.agentGrant.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: at } })).count === 1;
  }
}

export class PrismaConfirmationStore implements ConfirmationStore {
  private readonly maxEntries: number;
  constructor(private readonly db: PrismaClient, o: { maxEntries?: number } = {}) {
    this.maxEntries = o.maxEntries ?? 10_000;
  }

  /** Evicts expired rows, then inserts only while fewer than `maxEntries` live rows exist (single statement). */
  async create(c: Confirmation, now: number): Promise<void> {
    await this.db.agentConfirmation.deleteMany({ where: { expiresAt: { lte: new Date(now) } } });
    const inserted = await this.db.$executeRaw`
      INSERT INTO "AgentConfirmation" ("id","subject","userId","capability","inputHash","preview","status","expiresAt")
      SELECT ${c.id}::uuid, ${c.subject}, ${c.userId}, ${c.capability}, ${c.inputHash}, ${c.preview}, ${c.status}, ${new Date(c.expiresAt)}::timestamptz
      WHERE (SELECT count(*) FROM "AgentConfirmation") < ${this.maxEntries}`;
    if (inserted !== 1) throw new AppError("rate_limited", "Too many pending confirmations.", { headers: { "retry-after": "60" } });
  }

  countPending(subject: string, now: number): Promise<number> {
    return this.db.agentConfirmation.count({ where: { subject, status: "pending", expiresAt: { gt: new Date(now) } } });
  }

  async get(id: string): Promise<Confirmation | null> {
    if (!UUID.test(id)) return null; // user-supplied ids that cannot exist must not reach a uuid column
    const r = await this.db.agentConfirmation.findUnique({ where: { id } });
    return r ? { id: r.id, subject: r.subject, userId: r.userId, capability: r.capability, inputHash: r.inputHash, preview: r.preview, expiresAt: r.expiresAt.getTime(), status: r.status as ConfirmationStatus } : null;
  }

  /** Compare-and-set in one UPDATE: of N concurrent spenders exactly one matches `from`. */
  async transition(id: string, from: ConfirmationStatus, to: ConfirmationStatus): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return (await this.db.agentConfirmation.updateMany({ where: { id, status: from }, data: { status: to } })).count === 1;
  }
}

export class PrismaRateLimitStore implements RateLimitStore {
  private n = 0;
  private readonly sweepEvery: number;
  constructor(private readonly db: PrismaClient, o: { sweepEvery?: number } = {}) {
    this.sweepEvery = o.sweepEvery ?? 200;
  }

  async hit(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }> {
    if (++this.n % this.sweepEvery === 0) await this.db.rateLimitWindow.deleteMany({ where: { resetAt: { lte: new Date(now) } } }); // bounded table
    const nowD = new Date(now);
    const next = new Date(now + windowMs);
    const rows = await this.db.$queryRaw<{ count: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitWindow" ("key","count","resetAt") VALUES (${key}, 1, ${next}::timestamptz)
      ON CONFLICT ("key") DO UPDATE SET
        "count"   = CASE WHEN "RateLimitWindow"."resetAt" <= ${nowD}::timestamptz THEN 1 ELSE "RateLimitWindow"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimitWindow"."resetAt" <= ${nowD}::timestamptz THEN ${next}::timestamptz ELSE "RateLimitWindow"."resetAt" END
      RETURNING "count", "resetAt"`;
    const r = rows[0];
    if (!r) throw new Error("rate-limit upsert returned no row");
    return { count: Number(r.count), resetAt: r.resetAt.getTime() };
  }
}

export class PrismaReplayGuard implements ReplayGuard {
  private n = 0;
  constructor(private readonly db: PrismaClient, private readonly now: () => number = Date.now, private readonly sweepEvery = 200) {}

  /** First use (or reuse after expiry) → true. A live entry makes the conditional upsert return no row → replay. */
  async consume(id: string, expiresAtMs: number): Promise<boolean> {
    const t = this.now();
    if (++this.n % this.sweepEvery === 0) await this.db.replayEntry.deleteMany({ where: { expiresAt: { lte: new Date(t) } } });
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      INSERT INTO "ReplayEntry" ("id","expiresAt") VALUES (${id}, ${new Date(expiresAtMs)}::timestamptz)
      ON CONFLICT ("id") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt" WHERE "ReplayEntry"."expiresAt" <= ${new Date(t)}::timestamptz
      RETURNING "id"`;
    return rows.length === 1;
  }
}
