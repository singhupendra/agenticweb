# agenticweb

Reference architecture for an **agent-ready website**: a consulting-studio booking site usable by humans (Next.js UI) and AI agents (REST/OpenAPI, remote MCP, optional WebMCP) from one set of capabilities.

* Start here: [`docs/architecture.md`](docs/architecture.md), [`docs/CONTRACTS.md`](docs/CONTRACTS.md), [`docs/implementation-plan.md`](docs/implementation-plan.md)
* Ops: [`docs/deployment.md`](docs/deployment.md) · [`docs/observability.md`](docs/observability.md) · [`docs/troubleshooting.md`](docs/troubleshooting.md)
* Decisions: [`docs/technology-decisions.md`](docs/technology-decisions.md) · Threats: [`docs/threat-model.md`](docs/threat-model.md)

```bash
nvm use && pnpm install
cp .env.example .env.local
pnpm db:up && pnpm db:deploy && pnpm db:seed   # Postgres via docker compose
pnpm dev
pnpm lint && pnpm tsc --noEmit && pnpm test:run && pnpm build
```

Local Postgres without Docker: `brew install postgresql@16`, create role/db from `.env.example`, then `pnpm db:deploy && pnpm db:seed`.
Integration tests: `DATABASE_URL_TEST=<url of a migrated, disposable db> pnpm test:run`.

E2E: `pnpm exec playwright install chromium && E2E_DATABASE_URL=<migrated+seeded db> pnpm test:e2e` (see [`docs/agent-discovery.md`](docs/agent-discovery.md), [`docs/webmcp-integration.md`](docs/webmcp-integration.md)).
Production-like stack: `docker compose --profile app up --build` (add `--profile observability` for collector/Prometheus/Jaeger/Grafana).
