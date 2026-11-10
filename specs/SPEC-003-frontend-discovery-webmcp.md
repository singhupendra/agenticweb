# SPEC-003 Human site, machine readability, WebMCP (Phases 2 & 5, frontend)
Status: in progress

## Scope
Responsive accessible human site (home, services, service detail + availability + booking form, booking status, loading/error/not-found), reusable Schema.org JSON-LD, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, and feature-detected WebMCP. All data and mutations go through the capability executor (`getRuntime().executor.invoke`) with the actor from the shared `ActorResolver`; no business logic in UI.

## Acceptance criteria
1. Pages render from capabilities only; booking form submits `bookings.create` with a per-render Idempotency-Key (double submit = one booking). Anonymous visitors see a clear "sign-in required" state (real sign-in is Phase 3) instead of a broken form.
2. Booking status page uses `bookings.get`; non-owner/unknown id → not-found page; owner may cancel via `bookings.cancel`.
3. Semantic landmarks (header/nav/main/footer), single h1 per page, skip link, visible focus, labelled form controls, errors announced (`role="alert"`), no axe violations on the main pages.
4. JSON-LD generators (Organization, WebSite, WebPage, Service, Offer, LocalBusiness, FAQPage, BreadcrumbList) are pure, tested, safely serialised (`<` escaped), and only emitted for content visible on the page (FAQPage only where the FAQ is rendered).
5. `robots.txt` distinguishes search crawlers, AI user-agents and AI training crawlers, blocks `/api/` and `/bookings/`, lists the sitemap, and states it is advisory not security. `sitemap.xml` and `llms.txt` are generated from `src/agents/discovery/content.ts` plus the live service catalogue, falling back to static pages if the catalogue is unavailable.
6. WebMCP: feature-detect `document.modelContext` (current spec, 2026-11) with `navigator.modelContext` fallback; no-op when absent; tools are derived from the same Zod schemas/capability descriptors and call the same REST endpoints; mutating tools require explicit user confirmation; the site works fully without it.
7. Playwright E2E (chromium, desktop + mobile) for the human flows with axe checks; WebMCP registration verified with a polyfill.
