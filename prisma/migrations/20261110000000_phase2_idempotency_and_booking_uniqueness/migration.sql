-- Idempotency keys are scoped by (capability|actor subject), not by organization.
ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "IdempotencyRecord_organizationId_fkey";
DROP INDEX "IdempotencyRecord_organizationId_scope_key_key";
ALTER TABLE "IdempotencyRecord" DROP COLUMN "organizationId";
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- A user can hold at most one ACTIVE booking per slot (partial unique index; Prisma cannot model this).
CREATE UNIQUE INDEX "Booking_slotId_userId_active_key" ON "Booking"("slotId", "userId") WHERE "status" <> 'cancelled';

-- Slot invariants
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_capacity_positive" CHECK ("capacity" > 0);
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_ends_after_starts" CHECK ("endsAt" > "startsAt");
