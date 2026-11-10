/**
 * `tsx tests/agentic/support/with-test-db.ts -- <command…>`
 * Creates an isolated migrated+seeded database, runs the command with E2E_DATABASE_URL / QA_DATABASE_URL set, drops it.
 * If QA_DATABASE_URL is already set (must still be agenticweb_qa_*), it is reused and left in place.
 */
import { spawn } from "node:child_process";
import { assertIsolatedDb, createIsolatedDb, dropIsolatedDb } from "./test-db";

const cmd = process.argv.slice(process.argv.indexOf("--") + 1);
if (cmd.length === 0 || process.argv.indexOf("--") < 0) { console.error("usage: with-test-db.ts -- <command…>"); process.exit(2); }

const given = process.env.QA_DATABASE_URL;
if (given) assertIsolatedDb(given);
const url = given ?? (await createIsolatedDb());
console.error(`[qa] isolated database ready: ${new URL(url).pathname.slice(1)}`);
const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "inherit", env: { ...process.env, QA_DATABASE_URL: url, E2E_DATABASE_URL: url, DATABASE_URL: url } });
const code: number = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
if (!given) await dropIsolatedDb(url).catch((e) => console.error("[qa] cleanup failed:", e));
process.exit(code);
