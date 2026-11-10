# Agent discovery & machine readability

All generators live in `src/agents/discovery/` and are pure functions over one content source (`content.ts`) plus the live service catalogue (`catalog.ts`, loaded through the capability executor as an anonymous actor). The human pages use the same content, so copy, JSON-LD, sitemap and llms.txt cannot drift.

| Output | Route | Generator | Notes |
|---|---|---|---|
| robots.txt | `/robots.txt` | `robots.ts` | Search crawlers and user-initiated AI agents may read public pages; AI **training** crawlers are disallowed. `/api/` and `/bookings/` are disallowed for every group. |
| sitemap | `/sitemap.xml` | `sitemap.ts` | Static pages + one URL per service. Falls back to static pages (and `no-store`) if the catalogue is unavailable. |
| llms.txt | `/llms.txt` | `llms.ts` | llmstxt.org layout: H1, summary, Pages, Services, For agents (real REST endpoints only), FAQ. No OpenAPI/MCP links until Phase 4 ships them. |
| JSON-LD | inline `<script type="application/ld+json">` | `jsonld.ts` | Organization, WebSite, WebPage, Service (+Offer), LocalBusiness, FAQPage, BreadcrumbList. |

## robots.txt is not security
It is a voluntary convention. Honest crawlers follow it; malicious ones ignore it. Private data is protected by authentication/authorization in the capability layer. Listing a path in robots.txt also advertises it, so only low-sensitivity prefixes are listed. Edit the agent policy deliberately in `robots.ts` (`SEARCH_CRAWLERS`, `AI_USER_AGENTS`, `AI_TRAINING_CRAWLERS`); user-agent names change over time and should be re-checked against each vendor's docs.

## JSON-LD rules
* Emit a node only for content visible on the same page. FAQPage is generated from the same `SITE.faqs` the `<Faq>` component renders (a unit test renders the component and checks every Q&A appears; an E2E test checks it in the browser).
* Prices come from integer minor units (`priceFromMinor`), currency is ISO-4217, URLs are absolute (`APP_URL`).
* `localBusinessJsonLd` exists but is **not rendered**: the demo organization has no address. Render it only on a page that shows a real address.
* Serialization (`serializeJsonLd`) escapes `<` and U+2028/2029 so content can never break out of the `<script>` element.
* Validation test (`tests/discovery/jsonld.test.ts`) checks `@context`, `@type`, required properties per type, no `undefined`, JSON round-trip. It is not a substitute for Google's Rich Results Test, which was not run (needs a public URL).

## Adding content
Add a page: append to `SITE.pages` (sitemap + llms.txt update automatically). Add an FAQ: append to `SITE.faqs` (page, JSON-LD, llms.txt update automatically).

## Human site
`src/app/(website)/**`: server components call `getRuntime().executor.invoke(...)` through `_lib/data.ts` (thin, no rules). The visitor's actor comes from the same `defaultResolver()` REST uses (dev `x-dev-actor` header when `DEV_AUTH_ENABLED=true`; real sessions arrive in Phase 3, no UI change needed). Booking and cancel are server actions (`_actions/bookings.ts`) that map form data to `bookings.create` / `bookings.cancel`, with a per-render Idempotency-Key so double submits book once. Anonymous visitors see slots and a "sign in to book" notice.

Manual dev run of the signed-in flow: send `x-dev-actor: user|00000000-0000-4000-8000-0000000000b2|00000000-0000-4000-8000-0000000000a1` (e.g. with a header-modifier extension).

## E2E
`pnpm test:e2e` (Playwright, chromium desktop + Pixel 5, axe wcag2a/2aa/21a/21aa). Needs a migrated and seeded Postgres: `E2E_DATABASE_URL=<url> pnpm test:e2e` (default `DATABASE_URL`). The config starts `next dev` (dev auth is refused in production builds). `pnpm exec playwright install chromium` once. QA adds scenarios under `tests/e2e/`. Not yet wired into CI (Phase 6).

## Known gaps
* Booking output has no slot start time, so the status page shows the booking time, not the session time (needs a backend capability change).
* No "my bookings" list page, no real sign-in (Phase 3).
* `notFound()` pages return HTTP 200 + `noindex` when streaming has begun (documented Next behaviour with `loading.tsx`).
* Contrast/axe is automated only; no manual screen-reader pass.
