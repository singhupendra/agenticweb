/** Postgres-backed implementations of the idempotency and audit contracts. */
import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import type { AuditEvent, AuditLog } from "../logging/audit";
import { IDEMPOTENCY_LEASE_MS, type ClaimResult, type IdempotencyStore } from "../idempotency";

export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: PrismaClient) {}

  /** Atomic via the (scope,key) unique index; expired records/leases are superseded with a conditional UPDATE. */
  async claim(scope: string, key: string, requestHash: string, nowMs: number): Promise<ClaimResult> {
    const now = new Date(nowMs);
    const lease = new Date(nowMs + IDEMPOTENCY_LEASE_MS);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.db.idempotencyRecord.create({
          data: { scope, key, requestHash, state: "in_progress", leaseExpiresAt: lease, expiresAt: lease },
        });
        return { state: "acquired" };
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
      }
      const existing = await this.db.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
      if (!existing) continue; // released between our insert and read: retry the insert
      const expired = existing.state === "done" ? existing.expiresAt <= now : (existing.leaseExpiresAt ?? existing.expiresAt) <= now;
      if (expired) {
        // Conditional steal: only one concurrent claimant can match this exact row version.
        const stolen = await this.db.idempotencyRecord.updateMany({
          where: { id: existing.id, state: existing.state, expiresAt: existing.expiresAt, requestHash: existing.requestHash },
          data: { requestHash, state: "in_progress", response: Prisma.DbNull, leaseExpiresAt: lease, expiresAt: lease },
        });
        if (stolen.count === 1) return { state: "acquired" };
        continue;
      }
      if (existing.requestHash !== requestHash) return { state: "mismatch" };
      return existing.state === "done" ? { state: "done", response: existing.response } : { state: "in_progress" };
    }
    return { state: "in_progress" }; // heavy contention: let the client retry
  }

  async complete(scope: string, key: string, response: unknown, expiresAtMs: number): Promise<void> {
    await this.db.idempotencyRecord.update({
      where: { scope_key: { scope, key } },
      data: { state: "done", response: response as Prisma.InputJsonValue, expiresAt: new Date(expiresAtMs), leaseExpiresAt: null },
    });
  }

  async release(scope: string, key: string): Promise<void> {
    await this.db.idempotencyRecord.deleteMany({ where: { scope, key, state: "in_progress" } });
  }
}

export class PrismaAuditLog implements AuditLog {
  constructor(private readonly db: PrismaClient) {}
  async record(e: AuditEvent): Promise<void> {
    await this.db.auditEvent.create({
      data: {
        organizationId: e.organizationId ?? null,
        occurredAt: new Date(e.occurredAt),
        requestId: e.requestId,
        actorKind: e.actor.kind,
        actorId: e.actor.subject,
        onBehalfOf: e.actor.onBehalfOf ?? null,
        grantId: e.actor.grantId ?? null,
        capability: e.capability,
        outcome: e.outcome,
        resourceType: e.resource?.type ?? null,
        resourceId: e.resource?.id ?? null,
        inputHash: e.inputHash ?? null,
        detail: { ...(e.detail ?? {}), ...(e.actor.clientId ? { clientId: e.actor.clientId } : {}) } as Prisma.InputJsonValue,
      },
    });
  }
}
