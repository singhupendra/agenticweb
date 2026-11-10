/** Composition root: wires repositories, policy, audit, idempotency into one executor. */
import { createExecutor, type CapabilityExecutor } from "@/core/capabilities";
import { DefaultPolicy } from "@/core/authorization";
import { getEnv } from "@/core/env";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "@/core/idempotency";
import { createLogger, InMemoryAuditLog, type AuditLog, type Logger } from "@/core/logging";
import { createOrganizationService, type OrganizationRepository } from "@/modules/organization/service";
import { createPrismaOrganizationRepository } from "@/modules/organization/repository.prisma";
import { createServiceCatalog, type ServiceRepository } from "@/modules/services/service";
import { createPrismaServiceRepository } from "@/modules/services/repository.prisma";
import { getPrisma } from "@/core/db";
import { registry, type AppDeps } from "./capabilities";

export interface Runtime {
  executor: CapabilityExecutor;
  logger: Logger;
}

export function createRuntime(o: {
  organizations: OrganizationRepository;
  services: ServiceRepository;
  audit?: AuditLog;
  idempotency?: IdempotencyStore;
  logger?: Logger;
  clock?: () => Date;
}): Runtime {
  const organizations = createOrganizationService(o.organizations);
  const deps: AppDeps = { organizations, catalog: createServiceCatalog({ organizations, repo: o.services }) };
  const logger = o.logger ?? createLogger();
  return {
    logger,
    executor: createExecutor({
      registry,
      policy: new DefaultPolicy(o.clock),
      // TODO(Phase 2): Prisma-backed audit + idempotency. In-memory is per-process and NOT durable.
      audit: o.audit ?? new InMemoryAuditLog(),
      idempotency: o.idempotency ?? new InMemoryIdempotencyStore(),
      logger,
      deps,
      clock: o.clock,
    }),
  };
}

let runtime: Runtime | undefined;
export function getRuntime(): Runtime {
  if (!runtime) {
    const db = getPrisma();
    runtime = createRuntime({
      organizations: createPrismaOrganizationRepository(db),
      services: createPrismaServiceRepository(db),
      logger: createLogger({ level: getEnv().LOG_LEVEL }),
    });
  }
  return runtime;
}
