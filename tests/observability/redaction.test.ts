import { describe, expect, it } from "vitest";
import { createLogger } from "@/core/logging";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNpZw";
function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({ level: "debug", sink: (l) => lines.push(l) }) };
}

describe("log redaction (no tokens / PII in logs)", () => {
  it("redacts sensitive keys at any depth, in arrays, and case-insensitively", () => {
    const { lines, log } = capture();
    log.info("req", {
      headers: { Authorization: "Bearer abc.def.ghi", Cookie: "sid=1", "X-API-Key": "k-123" },
      nested: [{ password: "hunter2", Refresh_Token: "r-1" }],
      user: { email: "jane@example.com", phone: "+91 98765 43210", fullName: "Jane Doe" },
      idToken: JWT, clientSecret: "s3cr3t", session: "sess-1", csrfToken: "c-1",
    });
    const out = lines.join("\n");
    for (const leak of ["abc.def.ghi", "sid=1", "k-123", "hunter2", "r-1", "jane@example.com", "98765", "Jane Doe", JWT, "s3cr3t", "sess-1", "c-1"]) {
      expect(out, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it("scrubs token-shaped and email-shaped values inside free-form strings (messages and field values)", () => {
    const { lines, log } = capture();
    log.error(`upstream failed for jane@example.com with Authorization: Bearer abc123.def456`, {
      detail: `call https://x.test/cb?access_token=zzz999&ok=1 using ${JWT}`,
      error: new Error("bad token Bearer qqq111 for bob@corp.io"),
    });
    const out = lines.join("\n");
    for (const leak of ["jane@example.com", "abc123.def456", "zzz999", JWT, "qqq111", "bob@corp.io"]) {
      expect(out, `leaked ${leak}`).not.toContain(leak);
    }
    expect(out).toContain("[redacted]");
  });

  it("keeps useful non-sensitive context", () => {
    const { lines, log } = capture();
    log.child({ requestId: "r-42", capability: "services.list" }).info("ok", { status: 200, durationMs: 3 });
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: "info", msg: "ok", requestId: "r-42", capability: "services.list", status: 200, durationMs: 3 });
  });

  it("does not serialise error stacks or causes that may embed secrets", () => {
    const { lines, log } = capture();
    log.error("boom", { error: Object.assign(new Error("db down"), { cause: new Error("postgres://u:p4ss@h/db") }) });
    expect(lines.join("")).not.toContain("p4ss");
  });
});
