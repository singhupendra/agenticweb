/**
 * Isolated, disposable Postgres database for agentic/E2E runs.
 * SAFETY: only ever creates/drops databases whose name starts with `agenticweb_qa_`; every consumer re-checks via
 * assertIsolatedDb() so a dev/other-worker database can never be wiped by a test.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

export const QA_DB_PREFIX = "agenticweb_qa_";
const ADMIN_URL = () => process.env.QA_ADMIN_DATABASE_URL ?? "postgresql://agenticweb:agenticweb_dev_only@localhost:5432/postgres";

export function dbName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
export function assertIsolatedDb(url: string): void {
  if (!dbName(url).startsWith(QA_DB_PREFIX)) throw new Error(`Refusing to use "${dbName(url)}": test databases must be named ${QA_DB_PREFIX}*`);
}
const withDb = (name: string) => { const u = new URL(ADMIN_URL()); u.pathname = `/${name}`; return u.toString(); };

function run(cmd: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
}

/** Create a fresh database, apply migrations, seed it. Returns its URL. */
export async function createIsolatedDb(): Promise<string> {
  const name = `${QA_DB_PREFIX}${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL() });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const url = withDb(name);
  assertIsolatedDb(url);
  // Deliberately NON-UTC session zone so every run exercises zone-sensitive SQL (a real bug class; see test-report.md).
  const tz = new pg.Client({ connectionString: ADMIN_URL() });
  await tz.connect();
  try { await tz.query(`ALTER DATABASE ${name} SET timezone = 'Asia/Kolkata'`); } finally { await tz.end(); }
  run("pnpm", ["exec", "prisma", "migrate", "deploy"], { DATABASE_URL: url });
  run("pnpm", ["exec", "tsx", "prisma/seed.ts"], { DATABASE_URL: url });
  return url;
}

export async function dropIsolatedDb(url: string): Promise<void> {
  assertIsolatedDb(url);
  const admin = new pg.Client({ connectionString: ADMIN_URL() });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${dbName(url)} WITH (FORCE)`); } finally { await admin.end(); }
}
