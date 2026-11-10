# Test report — Phase 6 (QA / agentic testing)

Run: 2026-11-10, Node v24.15.0, pnpm 10.33.0, local Postgres 16 (brew, DB zone `Asia/Kolkata`), branch `ao/agentic-testing/e2e-evals`. All output below is raw from the commands, not paraphrased. Method and how to run: [`testing.md`](testing.md).

## Summary vs targets

| Target | Result |
|---|---|
| 100 % authz-negative and validation tests pass | **Met** — 34 server-backed negative tests + 10 authz eval attacks, all rejected with state unchanged |
| ≥ 95 % task success, deterministic dataset | **Met: 100 %** (16/16 book+recovery; 31/31 tasks) |
| Same outcome via MCP, REST, UI | **Met** — `channel-parity.spec.ts` compares DB rows from all three |
| LLM-dependent results | **Not run** (no `ANTHROPIC_API_KEY`; runner prints SKIPPED, nothing fabricated) |

## Findings (real defects found by this suite)

1. **FIXED — non-UTC database time zone corrupted every instant.** Prisma's pg adapter sends JS `Date`s as zone-less timestamps and reads `timestamptz` back without its offset. On a DB whose zone is not UTC (this machine: `Asia/Kolkata`) stored/compared instants shift by the offset: **a booking on an already-started slot could be cancelled** and slot listing/filters were wrong. Fix: pin the session to UTC (`PG_POOL_OPTIONS` in `src/core/db`, also `prisma/seed.ts`). Regression: `tests/db/timezone.integration.test.ts` (fails without the fix — verified: `expected 1893479400000 to be 1893499200000`). Existing dev databases seeded under a non-UTC zone hold shifted slot times; re-seed them.
2. **FIXED in the hardening PR (MCP) — confirmation gate ran before input validation.** An agent sending an *invalid* write (bad uuid, extra identity fields, over-long notes, missing idempotency key) gets `confirmation_required` and the human is asked to approve it; after approval the retry fails validation. Nothing executes, but it wastes the human's attention and consumes the 10-pending-per-agent quota. Suite asserts the safe end state (`rejectedInvalidWrite`). Suggested fix: validate first in the MCP handler.
3. **OPEN (Security) — a lost response after an approved write cannot be retried blindly:** the confirmation is single-use, so retry with the same `confirmationId` is refused even though the idempotency key would replay safely. The scripted agent reconciles via `list_my_bookings` (eval `recover-03/04` pass with exactly one booking); a naive client would be stuck until it asks for a new approval.
4. **Note:** unauthenticated requests with invalid params get `400` before `401` (validate → authorize pipeline order); no data leaks.
5. **Update (hardening PR):** the persistent `GrantStore` and Postgres confirmation/rate-limit/replay stores now exist (`AUTH_STORES=postgres`; real-Postgres tests in `tests/db/auth-stores.integration.test.ts`). The agentic suites below still need to be run against the server for grant revocation end-to-end. Item 3 is by design: an approval is spent when it is checked, so a timed-out or failed write needs a fresh approval for its (same-key, idempotent) retry.

## 1. Lint / types / build
```
$ pnpm lint
> agenticweb@0.1.0 lint /Users/upendrasingh/.ao/data/worktrees/agenticweb/agenticweb-8
> eslint .

lint exit 0
$ pnpm tsc --noEmit
tsc exit 0
$ pnpm build   (tail)


○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

build exit 0
```

## 2. Unit + contract + hermetic MCP + Postgres integration (`DATABASE_URL_TEST`=disposable `agenticweb_qa_unit`)
```
 Test Files  27 passed (27)
      Tests  403 passed (403)
   Duration  1.25s (tests 47%, import 37%, transform 13%, setup 1%, worker 1%)
unit exit 0
```
Includes `tests/agentic/mcp-resilience.test.ts` (MCP timeout → typed `timeout`, retry with same key → one booking; transient failure → no partial write), `eval-scoring.test.ts`, `llm-runner.test.ts` (plumbing + SKIPPED-without-key), `tests/db/timezone.integration.test.ts`.

## 3. Agentic E2E + negative suite (`pnpm test:agentic`, real app + isolated DB)
```
 ✓ tests/agentic/negative.agentic.ts (34 tests) 11057ms
   ✓ unauthorized booking (3)
     ✓ anonymous REST POST /bookings → 401; nothing created 475ms
   ✓ unavailable / past / unknown slots (4)
     ✓ a slot that already started → conflict (MCP, after human approval); nothing created 474ms
     ✓ cannot cancel a booking whose slot already started 505ms
   ✓ invalid ids / incorrect agent assumptions (6)
     ✓ unknown service slug → not_found via MCP and REST 497ms
   ✓ malicious input (4)
     ✓ SQL injection in search / ids is inert: no error leak, tables intact, no extra rows 793ms
   ✓ tokens: expired, wrong audience, forged, tampered (4)
     ✓ expired token → 401 invalid_token (REST and MCP); never degrades to anonymous even on public reads 7053ms
 ✓ tests/agentic/book-consultation.agentic.ts (2 tests) 195ms
 Test Files  2 passed (2)
      Tests  36 passed (36)
   Duration  13.48s (tests 98%, import 2%)
agentic exit 0
```

## 4. Deterministic evals (`pnpm eval`, dataset v1.0.0)
```
> agenticweb@0.1.0 eval /Users/upendrasingh/.ao/data/worktrees/agenticweb/agenticweb-8
> tsx evals/run.ts

## Deterministic eval — agenticweb-consulting-studio v1.0.0

| Metric | Value |
|---|---|
| Tasks (passed/total) | 31/31 |
| Task success rate (book + recovery) | 100.0% |
| Tool discovery rate | 100.0% |
| Execution reliability (unexpected tool errors) | 100.0% |
| Authorization safety (attacks rejected, state unchanged) | 100.0% |
| Transaction correctness (DB truth) | 100.0% |
| Recovery after injected transient faults | 100.0% |
| Tool-call latency p50 / p95 | 4 ms / 9 ms |
| Task latency p50 / p95 | 77 ms / 654 ms |
| Cost | 0 tokens — n/a: deterministic scripted agent, no model calls |

| Task | Category | Result | Detail |
|---|---|---|---|
| book-01 | book | PASS |  |
| book-02 | book | PASS |  |
| book-03 | book | PASS |  |
| book-04 | book | PASS |  |
| book-05 | book | PASS |  |
| book-06 | book | PASS |  |
| book-07 | book | PASS |  |
| book-08 | book | PASS |  |
| book-09 | book | PASS |  |
| book-10 | book | PASS |  |
| book-11 | book | PASS |  |
| book-12 | book | PASS |  |
| recover-01 | recovery | PASS |  |
| recover-02 | recovery | PASS |  |
| recover-03 | recovery | PASS |  |
| recover-04 | recovery | PASS |  |
| authz-01 | authz | PASS |  |
| authz-02 | authz | PASS |  |
| authz-03 | authz | PASS |  |
| authz-04 | authz | PASS |  |
| authz-05 | authz | PASS |  |
| authz-06 | authz | PASS |  |
| authz-07 | authz | PASS |  |
| authz-08 | authz | PASS |  |
| authz-09 | authz | PASS |  |
| authz-10 | authz | PASS |  |
| discover-01 | discovery | PASS |  |
| discover-02 | discovery | PASS |  |
| discover-03 | discovery | PASS |  |
| discover-04 | discovery | PASS |  |
| discover-05 | discovery | PASS |  |

Quality gates passed (success ≥ 95%, authorization safety 100%, transaction correctness 100%).
eval exit 0
```
Latency is from a `next dev` server (compile-on-demand, no optimisation): use for relative comparison only. Cost: no model calls (0 tokens).

## 5. Playwright (`pnpm test:e2e:isolated`; desktop + mobile; includes channel parity and XSS-inert UI test)
```
[qa] isolated database ready: agenticweb_qa_mwawp2w6_5ddcc9
  ✓   1 [desktop] › tests/e2e/channel-parity.spec.ts:16:3 › channel parity: book a consultation › MCP agent, REST client and human UI produce the same booking state (1.6s)
  ✓   2 [desktop] › tests/e2e/channel-parity.spec.ts:74:3 › channel parity: book a consultation › XSS in booking notes is rendered inert in the human UI (286ms)
  -  20 [mobile] › tests/e2e/channel-parity.spec.ts:16:3 › channel parity: book a consultation › MCP agent, REST client and human UI produce the same booking state
  -  21 [mobile] › tests/e2e/channel-parity.spec.ts:74:3 › channel parity: book a consultation › XSS in booking notes is rendered inert in the human UI
  3 skipped
  35 passed (23.2s)
e2e exit 0
```
The 3 skipped are intentional (`isMobile` for keyboard nav and the desktop-only parity tests).

## 6. LLM evals
`pnpm eval:llm` without a key → `SKIPPED: ANTHROPIC_API_KEY is not set …` (asserted by `llm-runner.test.ts`). No model results exist yet; run it with a key to populate `evals/results/llm-latest.md`.
