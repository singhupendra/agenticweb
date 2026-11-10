# Deployment

**Nothing in this repo deploys anywhere.** CI builds, tests and scans a container image but does not push it. This document is the contract for whoever wires a real target.

## Artifacts

| Artifact | Source | Notes |
|---|---|---|
| App image (`--target runner`) | `Dockerfile` | Multi-stage, Next.js `output: "standalone"`, base `node:24.22.2-alpine3.23`, runs as non-root `node`, no dev deps/source, `HEALTHCHECK` on `/api/health`. |
| Migration image (`--target migrate`) | `Dockerfile` | One-shot `prisma migrate deploy`; same non-root user. Run as a release step, **never at app start**. |
| Reference K8s manifests | `deploy/k8s/app.yaml` | Deployment (2 replicas, zero-downtime rolling), Service, PDB, migration Job, ConfigMap/Secret template, read-only root FS, dropped caps. |
| Dev stack | `docker-compose.yml` | Dev credentials only; profiles `app`, `observability`. |
| SBOM | CI artifact `sbom-cyclonedx` | CycloneDX of the built image. |

```bash
docker build --target runner  -t agenticweb:<sha> .
docker build --target migrate -t agenticweb-migrate:<sha> .
```

## Environment contract

Validated at startup by `src/core/env.ts` (the app refuses to start on invalid config). Add new variables there **and** in `.env.example`.

| Variable | Required | Production value / note |
|---|---|---|
| `NODE_ENV` | yes | `production` (set by the image). |
| `DATABASE_URL` | **yes (secret)** | `postgresql://…?sslmode=require`; role needs DML on app tables. Migration job needs DDL rights (use a separate, more privileged role if you split duties). |
| `APP_URL` | yes | Public origin (used for links/metadata). |
| `DEV_AUTH_ENABLED` | no | Must be unset/`false`. The app **refuses** `true` in production (tested). |
| `LOG_LEVEL` | no | `info` (default). |
| `DEFAULT_ORG_SLUG` | no | Demo org slug; default `northwind-studio`. |
| `OTEL_*` | no | See `docs/observability.md`. `OTEL_EXPORTER_OTLP_HEADERS` is a secret. |
| `PORT`, `HOSTNAME` | no | Image sets `3000`, `0.0.0.0`. |

Later phases add secrets (session/token signing keys, OAuth client config). Keep all secrets in the platform secret store; never bake them into images or commit them. CI secret scanning (Trivy) fails the build on detected secrets.

## Release sequence

1. CI green on `main` (lint, tsc, tests incl. Postgres, build, audit, container scan).
2. Build + push images (the pipeline that deploys owns registry credentials; not defined here). Pin by digest.
3. Run the **migrate** job against the target DB. Migrations must be backward compatible with the *currently running* app (expand → migrate → contract) so rollback never needs a DB downgrade.
4. Roll out the app. Traffic is gated by `/api/ready` (DB reachable); `/api/health` is liveness only.
5. Watch the Grafana dashboard / alerts for 15 min (error ratio, p95, authz rejections).

**Rollback:** redeploy the previous image digest (`kubectl rollout undo deployment/agenticweb`). Because step 3 is additive, the old app works on the new schema. Destructive schema changes ship in a later release after the old version is gone. Rehearsal is a Phase 7 exit criterion and has **not** been performed yet.

## Backups and runbooks (Phase 7 gaps)

* Use managed Postgres with PITR; take a snapshot before any migration that touches data. Restore drills: **not yet performed**.
* Incident runbooks live in `docs/troubleshooting.md`. Load test, staged deploy from CI and rollback rehearsal remain open items in the tracker.

## Security posture of the runtime

Non-root user, no extra packages, read-only root FS (tmpfs for `/tmp` and `.next/cache`), `cap_drop: ALL`, `no-new-privileges`, resource limits, probes. Images are scanned (Trivy + Grype) and fail the build on fixed HIGH/CRITICAL vulnerabilities.
