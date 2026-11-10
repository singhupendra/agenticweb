/** End-to-end through the REST adapter: token/cookie → resolveActor → gate → executor → problem+json. */
import { beforeEach, describe, expect, it } from "vitest";
import { createRestHandler, type RestDeps } from "@/api/rest";
import { AgentConfirmationGate, CONFIRMATION_HEADER } from "@/agents/policies";
import { InMemoryRateLimitStore, createRateLimiter } from "@/core/security";
import { APP_URL, REST_AUD, authKit, bearer, clock } from "./fixtures/auth";
import { NOW, ORG_ID, SLOTS, USER2_ID, USER_ID, testRuntime } from "./fixtures";

const MD = `${APP_URL}/.well-known/oauth-protected-resource`;
let kit: Awaited<ReturnType<typeof authKit>>;
let rt: ReturnType<typeof testRuntime>;
let gate: AgentConfirmationGate;
beforeEach(async () => {
  clock.now = NOW;
  kit = await authKit([
    { grantId: "grant-1", userId: USER_ID, clientId: "client-1", scopes: ["services:read", "bookings:read", "bookings:write"] },
    { grantId: "grant-ro", userId: USER_ID, clientId: "client-1", scopes: ["bookings:read"] },
  ]);
  rt = testRuntime();
  gate = new AgentConfirmationGate(undefined, () => clock.now.getTime());
});
const deps = (over: Partial<RestDeps> = {}): RestDeps => ({ runtime: () => rt, resolver: () => kit.resolver, gate: () => gate, appUrl: () => APP_URL, ...over });
const call = (cap: string, headers: Record<string, string>, o: { method?: string; body?: unknown; params?: Record<string, string>; deps?: Partial<RestDeps>; raw?: BodyInit } = {}) =>
  createRestHandler(cap, deps(o.deps))(
    new Request(`${APP_URL}/api/organizations/acme`, {
      method: o.method ?? "GET",
      headers: { ...(o.body !== undefined || o.raw ? { "content-type": "application/json" } : {}), ...headers },
      body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    }),
    { params: Promise.resolve({ orgSlug: "acme", ...o.params }) },
  );
const userTok = (userId = USER_ID, org = ORG_ID, o: object = {}) => kit.issuer.user({ userId, organizationId: org }, kit.opts(o));
const agentTok = (grantId = "grant-1", scopes = ["services:read", "bookings:read", "bookings:write"], o: object = {}) =>
  kit.issuer.agent({ clientId: "client-1", grantId, scopes, userId: USER_ID, organizationId: ORG_ID }, kit.opts(o));
async function seedBooking() {
  const made = await rt.executor.invoke("bookings.create", { kind: "user", userId: USER_ID, organizationId: ORG_ID }, { orgSlug: "acme", slotId: SLOTS.one.id }, { idempotencyKey: "seed-key-0003" });
  return (made.data as { id: string }).id;
}

describe("HTTP authn failures", () => {
  it("no credentials on a protected capability → 401 + resource_metadata challenge", async () => {
    const r = await call("bookings.list", {});
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${MD}"`);
    expect(r.headers.get("content-type")).toBe("application/problem+json");
  });
  it("expired token → 401 invalid_token (+metadata)", async () => {
    const t = await userTok(USER_ID, ORG_ID, { expiresInSec: 30 });
    clock.now = new Date(NOW.getTime() + 600_000);
    const r = await call("bookings.list", bearer(t));
    expect(r.status).toBe(401);
    const c = r.headers.get("www-authenticate") as string;
    expect(c).toContain('error="invalid_token"');
    expect(c).toContain(`resource_metadata="${MD}"`);
  });
  it("wrong audience → 401", async () =>
    expect((await call("bookings.list", bearer(await userTok(USER_ID, ORG_ID, { audience: "https://elsewhere.example" })))).status).toBe(401));
  it("an invalid token on a PUBLIC endpoint is still 401 (no silent downgrade to anonymous)", async () =>
    expect((await call("services.list", bearer("a.b.c"))).status).toBe(401));
  it("error bodies are generic problem+json (no stack, no jose internals)", async () => {
    const r = await call("bookings.list", bearer("a.b.c"));
    const body = await r.text();
    expect(body).not.toMatch(/jose|JWS|stack|at \w+ \(/i);
    expect(JSON.parse(body)).toMatchObject({ code: "unauthenticated", status: 401 });
  });
});

describe("HTTP authz", () => {
  it("IDOR: another user's token gets 404 for the booking, identical to a missing id", async () => {
    const id = await seedBooking();
    const other = bearer(await userTok(USER2_ID));
    const real = await call("bookings.get", other, { params: { bookingId: id } });
    const fake = await call("bookings.get", other, { params: { bookingId: "99999999-0000-4000-8000-000000000000" } });
    expect(real.status).toBe(404);
    expect(await real.json()).toMatchObject({ code: "not_found" });
    expect(fake.status).toBe(404);
    expect((await call("bookings.get", bearer(await userTok()), { params: { bookingId: id } })).status).toBe(200);
  });
  it("scope escalation: token claims bookings:write but the grant only allows read → 403 insufficient_scope", async () => {
    const id = await seedBooking();
    const t = await agentTok("grant-ro", ["bookings:read", "bookings:write"]);
    const r = await call("bookings.cancel", { ...bearer(t), "idempotency-key": "cancel-key-0001" }, { method: "POST", body: {}, params: { bookingId: id } });
    expect(r.status).toBe(403);
    const c = r.headers.get("www-authenticate") as string;
    expect(c).toContain('error="insufficient_scope"');
    expect(c).toContain('scope="bookings:write"');
    expect(c).toContain(`resource_metadata="${MD}"`);
    expect((await call("bookings.get", bearer(t), { params: { bookingId: id } })).status).toBe(200); // read is still fine
  });
  it("a user token cannot be used to reach another org's data", async () => {
    const id = await seedBooking();
    const r = await call("bookings.get", bearer(await userTok("aaaaaaaa-0000-4000-8000-000000000001", "22222222-2222-4222-8222-222222222222")), { params: { bookingId: id } });
    expect(r.status).toBe(404);
  });
  it("revoking the grant kills an unexpired token at once", async () => {
    const t = await agentTok();
    expect((await call("services.list", bearer(t))).status).toBe(200);
    kit.grantStore?.revoke("grant-1", NOW);
    expect((await call("services.list", bearer(t))).status).toBe(401);
  });
});

describe("agent confirmation for transactional scopes", () => {
  const create = (t: string, extra: Record<string, string> = {}, slotId: string = SLOTS.one.id) =>
    call("bookings.create", { ...bearer(t), "idempotency-key": "create-key-0001", ...extra }, { method: "POST", body: { slotId } });
  it("first attempt → 428 with a confirmation id; nothing is booked", async () => {
    const r = await create(await agentTok());
    expect(r.status).toBe(428);
    expect(r.headers.get(CONFIRMATION_HEADER)).toMatch(/[0-9a-f-]{36}/);
    expect(rt.bookingsRepo.bookings).toHaveLength(0);
  });
  it("pending confirmation is not enough; approval by the user → the retry succeeds; reuse is a replay → 403", async () => {
    const t = await agentTok();
    const id = (await create(t)).headers.get(CONFIRMATION_HEADER) as string;
    expect((await create(t, { [CONFIRMATION_HEADER]: id })).status).toBe(428);
    await gate.approve(id, { kind: "user", userId: USER_ID, organizationId: ORG_ID });
    expect((await create(t, { [CONFIRMATION_HEADER]: id })).status).toBe(201);
    expect((await create(t, { [CONFIRMATION_HEADER]: id }, SLOTS.two.id)).status).toBe(403);
    expect((await create(t, { [CONFIRMATION_HEADER]: id })).status).toBe(403); // consumed: replay rejected
  });
  it("an approval for one input cannot authorise a different input", async () => {
    const t = await agentTok();
    const id = (await create(t)).headers.get(CONFIRMATION_HEADER) as string;
    await gate.approve(id, { kind: "user", userId: USER_ID, organizationId: ORG_ID });
    expect((await create(t, { [CONFIRMATION_HEADER]: id }, SLOTS.two.id)).status).toBe(403);
  });
  it("only the delegating human can approve: not another user, not an agent", async () => {
    const t = await agentTok();
    const id = (await create(t)).headers.get(CONFIRMATION_HEADER) as string;
    await expect(gate.approve(id, { kind: "user", userId: USER2_ID, organizationId: ORG_ID })).rejects.toMatchObject({ code: "forbidden" });
    await expect(gate.approve(id, { kind: "agent", clientId: "client-1", onBehalfOf: { userId: USER_ID, organizationId: ORG_ID }, delegation: { grantId: "grant-1", scopes: ["bookings:write"], expiresAt: "2030-01-01T00:00:00Z" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(gate.approve(id, { kind: "anonymous" })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("confirmations expire", async () => {
    const t = await agentTok();
    const id = (await create(t)).headers.get(CONFIRMATION_HEADER) as string;
    await gate.approve(id, { kind: "user", userId: USER_ID, organizationId: ORG_ID });
    clock.now = new Date(NOW.getTime() + 6 * 60_000);
    expect((await create(await agentTok(), { [CONFIRMATION_HEADER]: id })).status).toBe(403);
  });
  it("read-only scopes and human users are never asked to confirm", async () => {
    expect((await call("services.list", bearer(await agentTok()))).status).toBe(200);
    const r = await call("bookings.create", { ...bearer(await userTok()), "idempotency-key": "create-key-0002" }, { method: "POST", body: { slotId: SLOTS.one.id } });
    expect(r.status).toBe(201);
  });
  it("an agent without the transactional scope gets 403 insufficient_scope, not a confirmation prompt", async () => {
    const r = await create(await agentTok("grant-ro", ["bookings:read"]));
    expect(r.status).toBe(403);
    expect(r.headers.get(CONFIRMATION_HEADER)).toBeNull();
  });
});

describe("cookie sessions through the adapter", () => {
  it("session user can book with CSRF token; without it the mutation is refused before execution", async () => {
    const { setCookie, csrfToken } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
    const cookie = setCookie.split(";")[0] as string;
    const base = { cookie, "idempotency-key": "create-key-0003" };
    const no = await call("bookings.create", base, { method: "POST", body: { slotId: SLOTS.one.id } });
    expect(no.status).toBe(403);
    const ok = await call("bookings.create", { ...base, "x-csrf-token": csrfToken, origin: APP_URL }, { method: "POST", body: { slotId: SLOTS.one.id } });
    expect(ok.status).toBe(201);
  });
});

describe("rate limits and request-size limits", () => {
  it("429 + Retry-After per subject, other subjects unaffected", async () => {
    const limiter = createRateLimiter({ store: new InMemoryRateLimitStore(), limit: 2, windowMs: 60_000, now: () => 1 });
    const t = bearer(await userTok());
    const d = { limiter: () => limiter };
    expect((await call("bookings.list", t, { deps: d })).status).toBe(200);
    expect((await call("bookings.list", t, { deps: d })).status).toBe(200);
    const r = await call("bookings.list", t, { deps: d });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await call("bookings.list", bearer(await userTok(USER2_ID)), { deps: d })).status).toBe(200);
  });
  it("failed authentication attempts also consume the client's budget", async () => {
    const limiter = createRateLimiter({ store: new InMemoryRateLimitStore(), limit: 2, windowMs: 60_000, now: () => 1 });
    const d = { limiter: () => limiter };
    for (let i = 0; i < 2; i++) expect((await call("bookings.list", bearer("a.b.c"), { deps: d })).status).toBe(401);
    expect((await call("bookings.list", bearer("a.b.c"), { deps: d })).status).toBe(429);
  });
  it("oversized body → 413; wrong content-type → 415; malformed JSON → 400", async () => {
    const t = { ...bearer(await userTok()), "idempotency-key": "create-key-0004" };
    const big = await call("bookings.create", t, { method: "POST", raw: JSON.stringify({ slotId: SLOTS.one.id, pad: "x".repeat(500) }), deps: { maxBodyBytes: () => 100 } });
    expect(big.status).toBe(413);
    const ct = await createRestHandler("bookings.create", deps())(new Request(`${APP_URL}/x`, { method: "POST", headers: { ...t, "content-type": "text/plain" }, body: "{}" }), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(ct.status).toBe(415);
    expect((await call("bookings.create", t, { method: "POST", raw: "{nope" })).status).toBe(400);
  });
});
void REST_AUD;
