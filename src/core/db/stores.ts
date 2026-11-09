/** Postgres-backed implementations of the idempotency and audit contracts. */
import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import type { AuditEvent, AuditLog } from "../logging/audit";
import type { IdempotencyStore, StoredResponse } from "../idempotency";

export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: PrismaClient, private readonly clock: () => Date = () => new Date()) {}

  async find(scope: string, key: string): Promise<StoredResponse | null> {
    const r = await this.db.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
    if (!r || r.expiresAt <= this.clock()) return null;
    return { requestHash: r.requestHash, response: r.response, expiresAt: r.expiresAt.getTime() };
  }

  /** Atomic via the (scope,key) unique index; false when another request already claimed the key. */
  async save(scope: string, key: string, v: StoredResponse): Promise<boolean> {
    try {
      await this.db.idempotencyRecord.create({
        data: { scope, key, requestHash: v.requestHash, response: v.response as Prisma.InputJsonValue, expiresAt: new Date(v.expiresAt) },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        // Expired leftovers must not block the key forever.
        const del = await this.db.idempotencyRecord.deleteMany({ where: { scope, key, expiresAt: { lte: this.clock() } } });
        if (del.count > 0) return this.save(scope, key, v);
        return false;
      }
      throw e;
    }
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
