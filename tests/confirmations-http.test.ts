/** Human approval endpoints: details + approve + decline, session-cookie (CSRF) and bearer paths. */
import { beforeEach, describe, expect, it } from "vitest";
import { approveConfirmation, declineConfirmation, describeConfirmation } from "@/api/confirmations";
import { AgentConfirmationGate } from "@/agents/policies";
import { APP_URL, authKit, bearer, clock, MCP_AUD } from "./fixtures/auth";
import { NOW, SLOTS, USER2_ID, USER_ID, ORG_ID, agent, user } from "./fixtures";

let kit: Awaited<ReturnType<typeof authKit>>;
let gate: AgentConfirmationGate;
let id: string;
beforeEach(async () => {
  clock.now = NOW;
  kit = await authKit();
  gate = new AgentConfirmationGate(undefined, () => clock.now.getTime());
  id = (await pending())!;
});
async function pending(): Promise<string | undefined> {
  try {
    await gate.check(agent(["bookings:write"]), { name: "bookings.create", mutating: true, requirement: { scope: "bookings:write" } }, { slotId: SLOTS.two.id, notes: "hello" }, null);
  } catch (e) {
    return (e as { headers: Record<string, string> }).headers["x-confirmation-id"];
  }
}
const deps = () => ({ resolver: () => kit.resolver, gate: () => gate, appUrl: () => APP_URL });
const ctx = (i = id) => ({ params: Promise.resolve({ id: i }) });
async function session(userId = USER_ID) {
  const s = await kit.sessions.create({ userId, organizationId: ORG_ID, role: "user" });
  return { cookie: s.setCookie.split(";")[0] as string, csrf: s.csrfToken };
}
const post = (h: Record<string, string>) => new Request(`${APP_URL}/api/confirmations/${id}/approve`, { method: "POST", headers: h });

describe("GET /api/confirmations/{id}", () => {
  it("shows the owner exactly what they would approve; no-store", async () => {
    const { cookie } = await session();
    const r = await describeConfirmation(new Request(`${APP_URL}/x`, { headers: { cookie } }), ctx(), deps());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = await r.json();
    expect(b.data).toMatchObject({ id, capability: "bookings.create", status: "pending" });
    expect(b.data.preview).toContain(SLOTS.two.id);
    expect(b.data).not.toHaveProperty("userId");
  });
  it("another user, anonymous and an unknown id are all the same 404/401-style non-disclosure", async () => {
    const other = await session(USER2_ID);
    expect((await describeConfirmation(new Request(`${APP_URL}/x`, { headers: { cookie: other.cookie } }), ctx(), deps())).status).toBe(404);
    expect((await describeConfirmation(new Request(`${APP_URL}/x`), ctx(), deps())).status).toBe(404);
    const { cookie } = await session();
    expect((await describeConfirmation(new Request(`${APP_URL}/x`, { headers: { cookie } }), ctx("nope-nope-nope"), deps())).status).toBe(404);
  });
});

describe("POST approve / decline", () => {
  it("cookie session without CSRF proof is refused (403) and nothing is approved", async () => {
    const { cookie } = await session();
    expect((await approveConfirmation(post({ cookie }), ctx(), deps())).status).toBe(403);
    expect((await gate.describe(id, user)).status).toBe("pending");
  });
  it("cookie + CSRF approves; the retry then works exactly once", async () => {
    const { cookie, csrf } = await session();
    expect((await approveConfirmation(post({ cookie, "x-csrf-token": csrf, origin: APP_URL }), ctx(), deps())).status).toBe(200);
    expect((await gate.describe(id, user)).status).toBe("approved");
    const cap = { name: "bookings.create", mutating: true, requirement: { scope: "bookings:write" as const } };
    await expect(gate.check(agent(["bookings:write"]), cap, { slotId: SLOTS.two.id, notes: "hello" }, id)).resolves.toBeUndefined();
    await expect(gate.check(agent(["bookings:write"]), cap, { slotId: SLOTS.two.id, notes: "hello" }, id)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("another user's session cannot approve (403)", async () => {
    const o = await session(USER2_ID);
    expect((await approveConfirmation(post({ cookie: o.cookie, "x-csrf-token": o.csrf }), ctx(), deps())).status).toBe(403);
  });
  it("a delegated agent token cannot approve its own action (403)", async () => {
    const t = await kit.issuer.agent({ clientId: "client-1", grantId: "grant-1", scopes: ["bookings:write"], userId: USER_ID, organizationId: ORG_ID }, kit.opts());
    expect((await approveConfirmation(post(bearer(t)), ctx(), deps())).status).toBe(403);
  });
  it("an MCP-audience token is not even accepted on this REST endpoint (401): the model cannot self-approve", async () => {
    const t = await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ audience: MCP_AUD }));
    expect((await approveConfirmation(post(bearer(t)), ctx(), deps())).status).toBe(401);
  });
  it("decline blocks the action permanently", async () => {
    const { cookie, csrf } = await session();
    expect((await declineConfirmation(post({ cookie, "x-csrf-token": csrf }), ctx(), deps())).status).toBe(200);
    expect((await approveConfirmation(post({ cookie, "x-csrf-token": csrf }), ctx(), deps())).status).toBe(403);
  });
  it("expired confirmations cannot be approved", async () => {
    const { cookie, csrf } = await session();
    clock.now = new Date(NOW.getTime() + 6 * 60_000);
    const s2 = await session();
    void s2;
    expect((await approveConfirmation(post({ cookie, "x-csrf-token": csrf }), ctx(), deps())).status).toBe(403);
  });
});
