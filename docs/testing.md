# Testing & agentic QA (Phase 6)

How the project proves that **humans and agents get the same correct, safe outcome from one set of capabilities**. Actual results: [`test-report.md`](test-report.md).

## Layers

| Layer | Where | Runs | Needs |
|---|---|---|---|
| Unit / contract / authz matrix / hermetic MCP | `tests/*.test.ts`, `tests/api`, `tests/mcp`, `tests/agentic/*.test.ts` | `pnpm test:run` (CI `verify`) | nothing |
| Postgres integration (overbooking, idempotency, **time zone**) | `tests/db` | `pnpm test:run` with `DATABASE_URL_TEST` | disposable DB — **truncates all tables** |
| **Agentic E2E + negative suite** (real Next app, real Postgres, MCP SDK client, mock issuer) | `tests/agentic/*.agentic.ts` | `pnpm test:agentic` | Postgres superuser (creates its own DB) |
| **Channel parity** MCP ⇔ REST ⇔ human UI (Playwright) | `tests/e2e/channel-parity.spec.ts` | `pnpm test:e2e:isolated` | Postgres + Chromium |
| Human-UI / a11y / discovery / WebMCP E2E | `tests/e2e/*.spec.ts` | `pnpm test:e2e:isolated` | same |
| **Deterministic evals** (fixed dataset v1) | `evals/` | `pnpm eval` (CI, gates the build) | Postgres |
| **LLM evals** (model-dependent, optional) | `evals/run-llm.ts` | `ANTHROPIC_API_KEY=… pnpm eval:llm` — **never in CI** | API key, costs money |

## Isolation (non-negotiable)

Agentic tests mutate data, so they **never touch a dev database**. `tests/agentic/support/with-test-db.ts` creates a fresh `agenticweb_qa_<id>` database on the admin connection (`QA_ADMIN_DATABASE_URL`, default `postgresql://agenticweb:agenticweb_dev_only@localhost:5432/postgres`), runs `prisma migrate deploy`, seeds it, runs the command, and drops it. Every consumer re-checks the name (`assertIsolatedDb`) and `playwright.config.ts` throws unless `E2E_DATABASE_URL` is an `agenticweb_qa_*` database. The QA databases are created with a **non-UTC default time zone** (`Asia/Kolkata`) on purpose, so the suite exercises zone-sensitive SQL on every run (this found a real bug — see the report).

```bash
nvm use && pnpm install && pnpm exec playwright install chromium
brew services start postgresql@16            # or: pnpm db:up (docker)
pnpm test:agentic            # MCP/REST agentic scenarios + negative suite
pnpm eval                    # deterministic evals, prints report, writes evals/results/ (gitignored)
pnpm test:e2e:isolated       # Playwright incl. channel parity
DATABASE_URL_TEST=<disposable db url> pnpm test:run   # includes tests/db
```

Debug against an existing disposable DB: `QA_DATABASE_URL=postgresql://…/agenticweb_qa_mine pnpm test:agentic` (reused, not dropped; must start with `agenticweb_qa_`).

## The agentic harness (no LLM)

* `support/app.ts` boots **`next dev`** (the mock issuer and dev-actor resolver are refused in production builds) on `AGENTIC_PORT` (3200) against the isolated DB.
* `support/clients.ts` (`Channels`): token minting via the app's own mock issuer (`/api/dev/mock-issuer/token`, same verification path as a real IdP), the official MCP SDK `Client` over Streamable HTTP, a REST helper, and **direct SQL for ground truth** (success is judged on Postgres state + audit rows, never on HTTP 200 alone).
* `support/agent.ts`: a deterministic scripted agent with a fixed policy — *discover tools → search → details → compare → availability → select → write (gate) → human approval → write → status*. It records a trace (tool, latency, outcome) for scoring, supports injected transient faults (`fail-before-send`, `drop-response` = the server committed but the reply is lost) and reconciles an unknown write outcome by reading its own bookings before retrying.
* The "human" approving a delegated write is simulated out-of-band: `POST /api/confirmations/{id}/approve` with a **user** bearer token — never the agent.

## Negative suite (`negative.agentic.ts`, 34 assertions-groups)

Each case asserts the specific rejection **and** unchanged state in Postgres: unauthorized booking (401 + challenge) · unavailable/past/unknown slot · invalid ids and wrong tenant · stale-slot assumption · missing `confirm`/idempotency key · identity-field injection (`userId`, `status`, `organizationId`) · SQLi in search/ids · XSS in notes (neutralised for agents, inert in the UI) · oversized notes/body/query/MCP body · malformed JSON / wrong content-type · prompt injection in a service name/description (tool descriptions stay static; results sanitised and flagged `agenticweb/untrusted`; no side effect) · IDOR read/update/cancel (404 indistinguishable from a non-existent id) · idempotent replay, same key + different payload (422), 8-way and 6-way concurrent races · expired token, wrong audience (both directions), tampered/`alg=none`/foreign-key tokens, token in query string · scope escalation (read-only agents, public-only agent, no human approval, forged confirmation id, agent self-approval, other user approving, no `admin:*` scope) · confirmation bound to the exact action and single-use. MCP **timeout** and **transient errors** are hermetic (`mcp-resilience.test.ts`, runs in `test:run`).

## Evals (`evals/`)

* `dataset/tasks.v1.json` — **frozen**, versioned (31 tasks: 12 book, 4 recovery, 10 authz, 5 discovery). Never edit in place; add `tasks.v2.json` so scores stay comparable.
* Metrics (`evals/lib.ts`): task success rate · tool discovery rate · execution reliability (unexpected tool errors; human-approval and injected faults are expected control flow) · authorization safety (attack rejected **and** state unchanged) · transaction correctness (exactly one correct booking in Postgres) · recovery rate · tool-call/task latency p50/p95 (dev-mode server: relative, not production numbers) · cost (tokens; $ if `EVAL_PRICE_*` set; 0/n-a for the deterministic agent).
* **Gates** (`pnpm eval` exits 1): task success ≥ 95 %, authorization safety 100 %, transaction correctness 100 %. Failed/crashed tasks are always listed — never excluded or retried silently.
* **LLM runner** (`pnpm eval:llm`): Anthropic Messages API tool-use loop over the same live MCP server; the simulated human approves gate requests; faults are injected into tool results. **Without `ANTHROPIC_API_KEY` it prints `SKIPPED` and writes nothing.** It reports whatever the model does (including failures). `tests/agentic/llm-runner.test.ts` tests only the loop plumbing with a scripted stand-in and is labelled as such — it is not a model result. Env: `EVAL_MODEL` (default `claude-sonnet-5-5`), `EVAL_LIMIT`, `EVAL_PRICE_IN_PER_MTOK`, `EVAL_PRICE_OUT_PER_MTOK`.

## CI

Job `agentic` in `.github/workflows/ci.yml` (own Postgres service; DBs created per command): `pnpm test:agentic` → `pnpm eval` → `pnpm test:e2e:isolated`; uploads `evals/results/`, `playwright-report/`, `test-results/`. `verify` still runs lint, `tsc`, `test:run` (incl. hermetic resilience tests and the DB suites) and build.

## Adding scenarios
1. New capability/scope → add it to `tests/authz-matrix.test.ts` (CONTRACTS §9) **and** a negative case here. 2. New task → new dataset version, not an edit. 3. Assert on database state. 4. Keep fixtures isolated per test (`ch.freshSlot()`); never rely on seed slots being free.
