-- Claim-before-execute idempotency: records start as 'in_progress' (with a lease) and become 'done'.
ALTER TABLE "IdempotencyRecord" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'done';
ALTER TABLE "IdempotencyRecord" ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ;
ALTER TABLE "IdempotencyRecord" ALTER COLUMN "response" DROP NOT NULL;
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_state_check" CHECK ("state" IN ('in_progress', 'done'));
