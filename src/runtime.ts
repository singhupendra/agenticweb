/** Composition root: wires repositories, policy, audit, idempotency into one executor. */
import { createExecutor, type CapabilityExecutor } from "@/core/capabilities";
import { DefaultPolicy } from "@/core/authorization";
import { getEnv } from "@/core/env";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "@/core/idempotency";
import { createLogger, InMemoryAuditLog, type AuditLog, type Logger } from "@/core/logging";
import { getPrisma, PrismaAuditLog, PrismaIdempotencyStore } from "@/core/db";
import type { PrismaClient } from "@/generated/prisma/client";
import { createOrganizationService, type OrganizationRepository } from "@/modules/organization/service";
import { createPrismaOrganizationRepository } from "@/modules/organization/repository.prisma";
import { createServiceCatalog, type ServiceRepository } from "@/modules/services/service";
import { createPrismaServiceRepository } from "@/modules/services/repository.prisma";
import { createBookingsService, type BookingRepository } from "@/modules/bookings/service";
import { createPrismaBookingRepository } from "@/modules/bookings/repository.prisma";
import { createOtelInstrument } from "@/observability";
import { registry, type AppDeps } from "./capabilities";

export interface Runtime {
  executor: CapabilityExecutor;
  logger: Logger;
}

export function createRuntime(o: {
  organizations: OrganizationRepository;
  services: ServiceRepository;
  bookings: BookingRepository;
  audit?: AuditLog;
  idempotency?: IdempotencyStore;
  logger?: Logger;
  clock?: () => Date;
}): Runtime {
  const organizations = createOrganizationService(o.organizations);
  const catalog = createServiceCatalog({ organizations, repo: o.services });
  const deps: AppDeps = { organizations, catalog, bookings: createBookingsService({ organizations, catalog, repo: o.bookings }) };
  const logger = o.logger ?? createLogger();
  return {
    logger,
    executor: createExecutor({
      registry,
      policy: new DefaultPolicy(o.clock),
      audit: o.audit ?? new InMemoryAuditLog(),
      idempotency: o.idempotency ?? new InMemoryIdempotencyStore(),
      logger,
      deps,
      clock: o.clock,
      instrument: createOtelInstrument(),
    }),
  };
}

/** Production wiring: Postgres repositories + durable idempotency + durable audit log. */
export function createPrismaRuntime(db: PrismaClient, o: { logger?: Logger; clock?: () => Date } = {}): Runtime {
  return createRuntime({
    organizations: createPrismaOrganizationRepository(db),
    services: createPrismaServiceRepository(db),
    bookings: createPrismaBookingRepository(db),
    audit: new PrismaAuditLog(db),
    idempotency: new PrismaIdempotencyStore(db),
    logger: o.logger,
    clock: o.clock,
  });
}

let runtime: Runtime | undefined;
export function getRuntime(): Runtime {
  return (runtime ??= createPrismaRuntime(getPrisma(), { logger: createLogger({ level: getEnv().LOG_LEVEL }) }));
}
