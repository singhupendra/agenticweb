import { describe, expect, it } from "vitest";
import type { Actor } from "@/core/auth";
import { AppError } from "@/core/errors";
import { createRestHandler } from "@/api/rest";
import { SLOTS, USER_ID, admin, agent, outsider, user, user2 } from "../fixtures";
import { BASE, assertProblem, createApp, findOperation, conforms } from "./harness";

const key = (n: number | string) => ({ "idempotency-key": `contract-key-${String(n).padStart(4, "0")}` });
const book = (app: ReturnType<typeof createApp>, actor: Actor | null = user, slotId = SLOTS.one.id, k: number | string = 1, extra: object = {}) =>
  app.call("POST", `${BASE}/bookings`, { actor: actor ?? undefined, body: { slotId, ...extra }, headers: key(k) });

describe("organization + services (public reads)", () => {
  it("GET organization → 200 envelope", async () => {
    const r = await createApp().call("GET", BASE);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ slug: "acme", name: "Acme" });
  });
  it("unknown org → 404 problem; malformed slug → 400 with field errors", async () => {
    const app = createApp();
    expect((await app.call("GET", "/api/organizations/nope")).status).toBe(404);
    const bad = await app.call("GET", "/api/organizations/BAD_SLUG");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("validation_failed");
    expect(bad.body.errors[0].path).toBe("orgSlug");
  });
  it("services list: pagination meta, Link header, filters, sorting", async () => {
    const app = createApp();
    const r = await app.call("GET", `${BASE}/services?pageSize=1&sort=-name`);
    expect(r.body.meta).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(r.body.data.map((s: { slug: string }) => s.slug)).toEqual(["service-2"]);
    const link = r.headers.get("link")!;
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
    expect(link).not.toContain('rel="prev"');
    expect(link).toContain("/api/organizations/acme/services?pageSize=1&sort=-name&page=2");
    const p2 = await app.call("GET", `${BASE}/services?pageSize=1&page=2&sort=-name`);
    expect(p2.headers.get("link")).toContain('rel="prev"');
    expect(p2.body.data.map((s: { slug: string }) => s.slug)).toEqual(["service-1"]);
    const beyond = await app.call("GET", `${BASE}/services?page=9`);
    expect(beyond.body).toMatchObject({ data: [], meta: { total: 2, page: 9 } });
    expect((await app.call("GET", `${BASE}/services?q=service%202`)).body.data).toHaveLength(1);
  });
  it("services list rejects invalid query values, unknown and repeated params", async () => {
    const app = createApp();
    for (const q of ["page=0", "page=abc", "pageSize=51", "pageSize=-1", "sort=bogus", "maxPriceMinor=-5", "unknown=1", "page=1&page=2", "q="]) {
      const r = await app.call("GET", `${BASE}/services?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.code).toBe("validation_failed");
    }
  });
  it("service get → 200 / 404 (inactive service is hidden)", async () => {
    const app = createApp();
    expect((await app.call("GET", `${BASE}/services/service-1`)).body.data.slug).toBe("service-1");
    expect((await app.call("GET", `${BASE}/services/nope`)).status).toBe(404);
    expect((await app.call("GET", `${BASE}/services/service-3`)).status).toBe(404);
  });
  it("slots list: sorted, filtered, validated", async () => {
    const app = createApp();
    const r = await app.call("GET", `${BASE}/services/service-1/slots?sort=-startsAt`);
    expect(r.body.data.map((s: { id: string }) => s.id)).toEqual([SLOTS.later.id, SLOTS.two.id, SLOTS.one.id]);
    expect((await app.call("GET", `${BASE}/services/service-1/slots?from=yesterday`)).status).toBe(400);
    expect((await app.call("GET", `${BASE}/services/nope/slots`)).status).toBe(404);
  });
});

describe("caching of public reads (ETag / Cache-Control / 304)", () => {
  it("emits a strong ETag and public Cache-Control; availability is cached for less time than the catalogue", async () => {
    const app = createApp();
    const s = await app.call("GET", `${BASE}/services`);
    expect(s.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(s.headers.get("cache-control")).toBe("public, max-age=60");
    const slots = await app.call("GET", `${BASE}/services/service-1/slots`);
    expect(slots.headers.get("cache-control")).toBe("public, max-age=10");
  });
  it("304 without body on If-None-Match (strong, weak, list and *), still carrying the ETag", async () => {
    const app = createApp();
    const first = await app.call("GET", `${BASE}/services/service-1`);
    const etag = first.headers.get("etag")!;
    for (const inm of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
      const r = await app.call("GET", `${BASE}/services/service-1`, { headers: { "if-none-match": inm } });
      expect(r.status, inm).toBe(304);
      expect(r.raw).toBe("");
      expect(r.headers.get("etag")).toBe(etag);
    }
    const miss = await app.call("GET", `${BASE}/services/service-1`, { headers: { "if-none-match": '"stale"' } });
    expect(miss.status).toBe(200);
  });
  it("ETag is independent of requestId and changes when the data changes", async () => {
    const app = createApp();
    const a = await app.call("GET", `${BASE}/services/service-1/slots`);
    const b = await app.call("GET", `${BASE}/services/service-1/slots`);
    expect(a.body.meta.requestId).not.toBe(b.body.meta.requestId);
    expect(a.headers.get("etag")).toBe(b.headers.get("etag"));
    await book(app, user, SLOTS.one.id); // consumes the only seat of slot one
    const c = await app.call("GET", `${BASE}/services/service-1/slots`);
    expect(c.headers.get("etag")).not.toBe(a.headers.get("etag"));
  });
  it("protected reads and all errors are never cacheable and carry no ETag", async () => {
    const app = createApp();
    await book(app);
    const mine = await app.call("GET", `${BASE}/bookings`, { actor: user });
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    expect(mine.headers.get("etag")).toBeNull();
    const err = await app.call("GET", `${BASE}/services/nope`);
    expect(err.headers.get("cache-control")).toBe("no-store");
    expect(err.headers.get("etag")).toBeNull();
  });
});

describe("bookings.create (POST)", () => {
  it("201 + Location + body matches spec; owner fields are not exposed", async () => {
    const app = createApp();
    const r = await book(app, user, SLOTS.one.id, 1, { notes: "hi" });
    expect(r.status).toBe(201);
    expect(r.headers.get("location")).toBe(`${BASE}/bookings/${r.body.data.id}`);
    expect(r.body.data).toMatchObject({ status: "confirmed", slotId: SLOTS.one.id, notes: "hi" });
    expect(r.body.data).not.toHaveProperty("userId");
    expect(r.body.data).not.toHaveProperty("organizationId");
  });
  it("401 when anonymous", async () => {
    const r = await book(createApp(), null);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
  });
  it("403 for an agent without the write scope; 201 with it", async () => {
    const app = createApp();
    expect((await book(app, agent(["bookings:read"]))).status).toBe(403);
    expect((await book(app, agent(["bookings:write"]), SLOTS.one.id, 2)).status).toBe(201);
  });
  it("400 when the Idempotency-Key is missing or malformed", async () => {
    const app = createApp();
    const missing = await app.call("POST", `${BASE}/bookings`, { actor: user, body: { slotId: SLOTS.one.id } });
    expect(missing.body.code).toBe("idempotency_key_required");
    for (const k of ["short", "has spaces in it!", "x".repeat(129)]) {
      expect((await app.call("POST", `${BASE}/bookings`, { actor: user, body: { slotId: SLOTS.one.id }, headers: { "idempotency-key": k } })).status, k).toBe(400);
    }
  });
  it("400 for missing fields, wrong types, bad formats, forbidden fields", async () => {
    const app = createApp();
    const cases: [string, unknown][] = [
      ["missing slotId", {}],
      ["wrong type slotId", { slotId: 123 }],
      ["not a uuid", { slotId: "abc" }],
      ["wrong type notes", { slotId: SLOTS.one.id, notes: 5 }],
      ["notes too long", { slotId: SLOTS.one.id, notes: "x".repeat(1001) }],
      ["userId injection", { slotId: SLOTS.one.id, userId: user2.userId }],
      ["status injection", { slotId: SLOTS.one.id, status: "confirmed" }],
      ["organizationId injection", { slotId: SLOTS.one.id, organizationId: "x" }],
      ["null slotId", { slotId: null }],
    ];
    for (const [label, body] of cases) {
      const r = await app.call("POST", `${BASE}/bookings`, { actor: user, body, headers: key(label.length + 100) });
      expect(r.status, label).toBe(400);
      expect(r.body.code, label).toBe("validation_failed");
      expect(r.body.errors.length, label).toBeGreaterThan(0);
    }
    expect(app.rt.bookingsRepo.bookings).toHaveLength(0);
  });
  it("transport errors: invalid JSON → 400, array/scalar body → 400, wrong content-type → 415, oversize → 413", async () => {
    const app = createApp();
    const post = (o: Parameters<typeof app.call>[2]) => app.call("POST", `${BASE}/bookings`, { actor: user, headers: key(7), ...o });
    const badJson = await post({ rawBody: "{nope", headers: { ...key(7), "content-type": "application/json" } });
    expect(badJson.status).toBe(400);
    expect(badJson.body.errors[0].message).toMatch(/valid JSON/);
    expect((await post({ rawBody: "[1]", headers: { ...key(7), "content-type": "application/json" } })).status).toBe(400);
    expect((await post({ rawBody: '"x"', headers: { ...key(7), "content-type": "application/json" } })).status).toBe(400);
    const ct = await post({ rawBody: JSON.stringify({ slotId: SLOTS.one.id }), headers: { ...key(7), "content-type": "text/plain" } });
    expect(ct.status).toBe(415);
    expect(ct.body.code).toBe("unsupported_media_type");
    const big = await post({ rawBody: JSON.stringify({ slotId: SLOTS.one.id, notes: "x".repeat(70_000) }), headers: { ...key(7), "content-type": "application/json" } });
    expect(big.status).toBe(413);
    expect(app.rt.bookingsRepo.bookings).toHaveLength(0);
  });
  it("409 when the slot is full or already booked by the user; 404 for unknown/other-org slot", async () => {
    const app = createApp();
    expect((await book(app, user, SLOTS.one.id, 1)).status).toBe(201);
    const full = await book(app, user2, SLOTS.one.id, 2);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("conflict");
    expect((await book(app, user, SLOTS.two.id, 3)).status).toBe(201);
    expect((await book(app, user, SLOTS.two.id, 4)).status).toBe(409);
    expect((await book(app, user, SLOTS.otherOrg.id, 5)).status).toBe(404);
    expect((await book(app, user, "00000000-0000-4000-8000-000000000000", 6)).status).toBe(404);
  });
  it("tenant isolation: an actor from another organization cannot book (404)", async () => {
    const r = await book(createApp(), outsider, SLOTS.one.id, 1);
    expect(r.status).toBe(404);
  });
});

describe("idempotency over HTTP", () => {
  it("same key + same body replays the original response without a second booking", async () => {
    const app = createApp();
    const a = await book(app, user, SLOTS.two.id, "same");
    const b = await book(app, user, SLOTS.two.id, "same");
    expect(b.status).toBe(201);
    expect(b.body.data).toEqual(a.body.data);
    expect(app.rt.bookingsRepo.bookings).toHaveLength(1);
  });
  it("same key + different body → 422 idempotency_key_reuse", async () => {
    const app = createApp();
    await book(app, user, SLOTS.two.id, "same");
    const r = await book(app, user, SLOTS.one.id, "same");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("idempotency_key_reuse");
    expect(app.rt.bookingsRepo.bookings).toHaveLength(1);
  });
  it("keys are scoped per actor: another user with the same key is not a replay", async () => {
    const app = createApp();
    await book(app, user, SLOTS.two.id, "shared");
    const r = await book(app, user2, SLOTS.two.id, "shared");
    expect(r.status).toBe(201);
    expect(app.rt.bookingsRepo.bookings).toHaveLength(2);
  });
  it("PATCH and cancel are idempotent too", async () => {
    const app = createApp();
    const { body } = await book(app, user, SLOTS.one.id, 1);
    const id = body.data.id;
    const p1 = await app.call("PATCH", `${BASE}/bookings/${id}`, { actor: user, body: { notes: "a" }, headers: key(2) });
    const p2 = await app.call("PATCH", `${BASE}/bookings/${id}`, { actor: user, body: { notes: "a" }, headers: key(2) });
    expect(p2.body.data).toEqual(p1.body.data);
    const c1 = await app.call("DELETE", `${BASE}/bookings/${id}`, { actor: user, headers: key(3) });
    const c2 = await app.call("DELETE", `${BASE}/bookings/${id}`, { actor: user, headers: key(3) });
    expect(c2.body.data).toEqual(c1.body.data);
  });
});

describe("bookings read / list / patch / cancel", () => {
  it("GET one: owner 200, admin 200, other user 404 (no IDOR), anonymous 401, bad id 400", async () => {
    const app = createApp();
    const id = (await book(app)).body.data.id;
    expect((await app.call("GET", `${BASE}/bookings/${id}`, { actor: user })).status).toBe(200);
    expect((await app.call("GET", `${BASE}/bookings/${id}`, { actor: admin })).status).toBe(200);
    expect((await app.call("GET", `${BASE}/bookings/${id}`, { actor: user2 })).status).toBe(404);
    expect((await app.call("GET", `${BASE}/bookings/${id}`, { actor: outsider })).status).toBe(404);
    expect((await app.call("GET", `${BASE}/bookings/${id}`)).status).toBe(401);
    expect((await app.call("GET", `${BASE}/bookings/not-a-uuid`, { actor: user })).status).toBe(400);
    expect((await app.call("GET", `${BASE}/bookings/00000000-0000-4000-8000-000000000000`, { actor: user })).status).toBe(404);
    expect((await app.call("GET", `${BASE}/bookings/${id}`, { actor: agent(["services:read"]) })).status).toBe(403);
    expect((await app.call("GET", `${BASE}/bookings/${id}`, { actor: agent(["bookings:read"]) })).status).toBe(200);
  });
  it("list mine: only own bookings; status filter; sort; pagination; validation", async () => {
    const app = createApp();
    const a = (await book(app, user, SLOTS.one.id, 1)).body.data.id;
    await book(app, user, SLOTS.two.id, 2);
    await book(app, user2, SLOTS.two.id, 3);
    await app.call("DELETE", `${BASE}/bookings/${a}`, { actor: user, headers: key(4) });
    const all = await app.call("GET", `${BASE}/bookings`, { actor: user });
    expect(all.body.meta.total).toBe(2);
    const c = await app.call("GET", `${BASE}/bookings?status=cancelled`, { actor: user });
    expect(c.body.data.map((b: { id: string }) => b.id)).toEqual([a]);
    const page = await app.call("GET", `${BASE}/bookings?pageSize=1&sort=createdAt`, { actor: user });
    expect(page.body.data).toHaveLength(1);
    expect(page.headers.get("link")).toContain('rel="next"');
    for (const q of ["status=nope", "sort=id", "pageSize=0"]) expect((await app.call("GET", `${BASE}/bookings?${q}`, { actor: user })).status, q).toBe(400);
    expect((await app.call("GET", `${BASE}/bookings`)).status).toBe(401);
  });
  it("PATCH: updates notes, clears with null; 400 invalid; 404 non-owner; 409 cancelled; 401 anonymous", async () => {
    const app = createApp();
    const id = (await book(app, user, SLOTS.one.id, 1, { notes: "old" })).body.data.id;
    const patch = (actor: Actor | undefined, body: unknown, k: number) =>
      app.call("PATCH", `${BASE}/bookings/${id}`, { actor, body, headers: key(k) });
    expect((await patch(user, { notes: "new" }, 2)).body.data.notes).toBe("new");
    expect((await patch(admin, { notes: null }, 3)).body.data.notes).toBeNull();
    for (const [label, body] of [["empty", {}], ["number", { notes: 5 }], ["extra", { notes: "x", status: "cancelled" }], ["long", { notes: "x".repeat(1001) }]] as const) {
      expect((await patch(user, body, 10)).status, label).toBe(400);
    }
    expect((await patch(user2, { notes: "x" }, 4)).status).toBe(404);
    expect((await patch(undefined, { notes: "x" }, 5)).status).toBe(401);
    expect((await app.call("PATCH", `${BASE}/bookings/${id}`, { actor: user, body: { notes: "x" } })).body.code).toBe("idempotency_key_required");
    await app.call("DELETE", `${BASE}/bookings/${id}`, { actor: user, headers: key(6) });
    expect((await patch(user, { notes: "x" }, 7)).status).toBe(409);
  });
  it("DELETE and POST …/cancel both cancel; non-owner 404; started slot 409 is not exercised here", async () => {
    const app = createApp();
    const a = (await book(app, user, SLOTS.one.id, 1)).body.data.id;
    const b = (await book(app, user, SLOTS.two.id, 2)).body.data.id;
    expect((await app.call("DELETE", `${BASE}/bookings/${a}`, { actor: user2, headers: key(3) })).status).toBe(404);
    expect((await app.call("DELETE", `${BASE}/bookings/${a}`, { actor: user, headers: key(4) })).body.data.status).toBe("cancelled");
    expect((await app.call("POST", `${BASE}/bookings/${b}/cancel`, { actor: user, headers: key(5) })).body.data.status).toBe("cancelled");
    expect((await app.call("DELETE", `${BASE}/bookings/${a}`, { actor: user })).body.code).toBe("idempotency_key_required");
    // the freed seat is bookable again
    expect((await book(app, user2, SLOTS.one.id, 6)).status).toBe(201);
  });
});

describe("adapter behaviour", () => {
  it("echoes a supplied x-request-id in header, envelope and problem", async () => {
    const app = createApp();
    const ok = await app.call("GET", BASE, { headers: { "x-request-id": "req-abc" } });
    expect(ok.headers.get("x-request-id")).toBe("req-abc");
    expect(ok.body.meta.requestId).toBe("req-abc");
    const bad = await app.call("GET", `${BASE}/services/nope`, { headers: { "x-request-id": "req-def" } });
    expect(bad.headers.get("x-request-id")).toBe("req-def");
    expect(bad.body.requestId).toBe("req-def");
  });
  it("405 problem (with Allow) when a handler is invoked with an unsupported method", async () => {
    const app = createApp();
    const h = createRestHandler("services.list", app.deps);
    const res = await h(new Request("http://localhost/api/organizations/acme/services", { method: "POST" }), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    assertProblem({ status: 405, headers: res.headers, body: await res.json(), raw: "", res }, "/api/organizations/acme/services");
  });
  it("rate-limit hook: a thrown rate_limited becomes a spec'd 429 problem with Retry-After", async () => {
    const app = createApp({
      rateLimit: ({ actor }) => {
        if (actor.kind === "anonymous") throw new AppError("rate_limited", "Slow down.", { headers: { "retry-after": "30" } });
      },
    });
    const r = await app.call("GET", `${BASE}/services`);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(r.body.code).toBe("rate_limited");
    expect((await app.call("GET", `${BASE}/services`, { actor: user })).status).toBe(200);
  });
  it("unexpected failures → generic 500 problem without leaking internals", async () => {
    const app = createApp({ runtime: () => { throw new Error("db password=hunter2"); } });
    const r = await app.call("GET", BASE, { check: false });
    expect(r.status).toBe(500);
    conforms("GET", BASE, r);
    expect(r.raw).not.toContain("hunter2");
    expect(r.body.detail).toBeUndefined();
  });
  it("path params cannot be overridden by query or body", async () => {
    const app = createApp();
    const id = (await book(app)).body.data.id;
    const r = await app.call("GET", `${BASE}/bookings/${id}?bookingId=00000000-0000-4000-8000-000000000000&orgSlug=other`, { actor: user });
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(id);
  });
  it("every documented operation is reachable and answers with a documented status (smoke over the whole spec)", async () => {
    const app = createApp();
    const id = (await book(app)).body.data.id;
    const concrete = (p: string) => p.replace("{orgSlug}", "acme").replace("{serviceSlug}", "service-1").replace("{bookingId}", id);
    for (const [template, item] of Object.entries((await import("./harness")).doc.paths)) {
      if (template.includes("health") || template.includes("ready")) continue;
      for (const method of Object.keys(item)) {
        const path = concrete(template);
        expect(findOperation(method.toUpperCase(), path)).toBeDefined();
        const r = await app.call(method.toUpperCase(), path, { actor: user, headers: key(`smoke-${method}-${template.length}`), body: method === "post" && !template.includes("cancel") ? { slotId: SLOTS.two.id } : method === "patch" ? { notes: "s" } : undefined });
        expect(r.status, `${method} ${path}`).toBeLessThan(500);
      }
    }
    void USER_ID;
  });
});
