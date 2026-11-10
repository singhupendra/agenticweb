# Technology decisions

Versions verified against the npm registry on **2026-11-09** (`npm view <pkg> version` / `dist-tags`). Actual installed versions are in `pnpm-lock.yaml`; `package.json` pins exact versions for runtime deps.

## Pinned stack

| Area | Choice | Version | Verification / rationale |
|---|---|---|---|
| Runtime | Node.js LTS | 24.x (`.nvmrc`=24) | Vitest 5 requires `^22 ‖ ^24 ‖ >=26`; v25 (odd, non-LTS) is outside that range. |
| Package manager | pnpm | 10.x | per workspace CLAUDE.md |
| Framework | Next.js (App Router) | 16.4.5 | npm `latest` |
| UI | React / react-dom | 19.3.1 | npm `latest`; Next peer `^19` |
| CSS | Tailwind CSS + `@tailwindcss/postcss` | 4.3.5 | npm `latest` (v4 CSS-first config) |
| Language | TypeScript | **~6.0.3** (not 7.0.2) | npm `latest` is 7.0.2, but `typescript-eslint@8.72` peers `<6.1.0`. Pinned to newest 6.0.x for a working lint toolchain. Revisit when typescript-eslint supports 7. |
| ORM | **Prisma** | 7.10.1 (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) | `@prisma/client` `latest` = 7.10.1. `prisma` CLI `latest` tag points at `8.0.0-rc.33` (release candidate) → rejected; client and CLI pinned to matching stable 7.10.1. |
| DB driver | `pg` | 8.23.1 | required by adapter-pg |
| Validation | Zod | 4.6.7 | npm `latest`; MCP SDK peers `^3.25 ‖ ^4`; Zod 4 ships native `z.toJSONSchema`, used for OpenAPI/MCP schemas. |
| MCP | `@modelcontextprotocol/sdk` | 1.32.2 | npm `latest` (Phase 4 consumer; added when used) |
| Unit/integration tests | Vitest | 5.1.0 | npm `latest` |
| E2E | `@playwright/test` | 1.65.0 | npm `latest`; Next peer accepts `^1.51.1` (Phase 6 consumer) |
| Observability | `@opentelemetry/api` 1.10.0, `@opentelemetry/sdk-node` 0.301.0 | | npm `latest` (Phase 6). sdk-node requires node >=22.15. |
| Lint | ESLint **9.39.x** + `eslint-config-next` 16.4.5 + `typescript-eslint` | | npm `latest` ESLint is 10.14, but eslint-config-next's plugin set is only guaranteed on `>=9`; 9.39 chosen as the conservative, widely supported line. |
| Logging | custom minimal JSON logger | — | avoids a dependency; Pino is the upgrade path (10.4.0). |

## Key decisions

**D1 — Prisma over Drizzle.** Migrations and seed are first-class, schema is a single readable file other workers can extend, generated types feed Zod mapping. Drizzle is lighter, but Prisma 7's removal of the Rust engine (driver adapters) removed the main objection.

**D2 — Modular monolith, not microservices.** One deploy, strict module boundaries (see architecture.md).

**D3 — Zod is the single schema language.** Validation, REST bodies, MCP tool input, JSON Schema, OpenAPI all derive from Zod schemas in `src/modules/*/schemas.ts`.

**D4 — RFC 9457 problem+json for all REST errors**; MCP maps the same model.

**D5 — Capability registry** is the only way behaviour is exposed; see architecture §4.

**D6 — MCP: remote Streamable HTTP**, stateless, hosted in the Next app; stdio is not used.

**D7 — No paid services.** Postgres via docker-compose; GitHub Actions free tier; no hosted auth/LLM dependencies.

## Assumptions (to be challenged)

1. Single-tenant now; `organizationId` on every tenant-owned row.
2. Auth mechanism (session cookie for humans, OAuth 2.1 access tokens with scopes for agents) is Phase 3; Phase 1 ships types and a dev-only header resolver explicitly **disabled in production**.
3. Prices are integer minor units with ISO 4217 currency; no tax logic.
4. Slot times are UTC; display timezone is organization-level.
5. Node 24 is available in CI and local (`nvm use`). The local default shell was Node 25.6.1; verification was run on Node 24.
6. TypeScript 7 (native) compatibility with Next 16 and typescript-eslint is unverified, hence TS 6.0.
7. Version numbers can drift; re-verify before Phase 7 hardening.
