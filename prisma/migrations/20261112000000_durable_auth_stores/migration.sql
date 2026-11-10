-- Durable, multi-instance-safe auth/security stores (replace the per-process in-memory defaults).

-- Delegation grants (GrantStore): authoritative server-side record of what a user consented to for an agent client.
-- userId is the IdP subject (text), deliberately without a FK to User.
CREATE TABLE "AgentGrant" (
  "grantId"   TEXT        NOT NULL,
  "userId"    TEXT        NOT NULL,
  "clientId"  TEXT        NOT NULL,
  "scopes"    TEXT[]      NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "revokedAt" TIMESTAMPTZ,
  CONSTRAINT "AgentGrant_pkey" PRIMARY KEY ("grantId")
);
CREATE INDEX "AgentGrant_userId_idx" ON "AgentGrant"("userId");

-- Human confirmations for agent/MCP writes (ConfirmationStore). Bound to subject + capability + input hash + expiry.
CREATE TABLE "AgentConfirmation" (
  "id"         UUID        NOT NULL,
  "subject"    TEXT        NOT NULL,
  "userId"     TEXT        NOT NULL,
  "capability" TEXT        NOT NULL,
  "inputHash"  TEXT        NOT NULL,
  "preview"    TEXT        NOT NULL,
  "status"     TEXT        NOT NULL DEFAULT 'pending',
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "AgentConfirmation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentConfirmation_status_check" CHECK ("status" IN ('pending', 'approved', 'consumed', 'denied'))
);
CREATE INDEX "AgentConfirmation_subject_status_expiresAt_idx" ON "AgentConfirmation"("subject", "status", "expiresAt");
CREATE INDEX "AgentConfirmation_expiresAt_idx" ON "AgentConfirmation"("expiresAt");

-- Fixed-window rate-limit counters (RateLimitStore); incremented atomically with INSERT .. ON CONFLICT.
CREATE TABLE "RateLimitWindow" (
  "key"     TEXT        NOT NULL,
  "count"   INTEGER     NOT NULL,
  "resetAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "RateLimitWindow_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "RateLimitWindow_resetAt_idx" ON "RateLimitWindow"("resetAt");

-- Single-use artefacts (ReplayGuard): jti / nonce / one-time tokens.
CREATE TABLE "ReplayEntry" (
  "id"        TEXT        NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "ReplayEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReplayEntry_expiresAt_idx" ON "ReplayEntry"("expiresAt");
