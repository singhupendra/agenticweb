/**
 * Single maintainable source for static site content. The human pages, JSON-LD, sitemap and llms.txt are all
 * generated from this file plus the live service catalogue, so they cannot drift apart.
 * Edit copy here; do not duplicate it in components.
 */
export interface Faq { question: string; answer: string }
export interface StaticPage { path: string; title: string; description: string; changeFrequency: "weekly" | "monthly" }

export const SITE = {
  summary: "Book expert consulting sessions online. The same booking capabilities are available to people through this website and to AI agents through a documented REST API.",
  tagline: "Consulting sessions, booked by people or by your AI agent.",
  pages: [
    { path: "/", title: "Home", description: "Consulting sessions you can book online.", changeFrequency: "weekly" },
    { path: "/services", title: "Services", description: "All consulting services with duration and price.", changeFrequency: "weekly" },
  ] satisfies StaticPage[],
  howItWorks: [
    { title: "Choose a service", body: "Browse the services and pick the one that fits." },
    { title: "Pick a time", body: "Select any open slot; times are shown in the studio's timezone." },
    { title: "Confirm", body: "Sign in, confirm your booking and keep the reference to check or cancel it later." },
  ],
  faqs: [
    { question: "How do I book a session?", answer: "Open a service, choose an available slot and confirm your booking. You need to be signed in to book." },
    { question: "Can I cancel a booking?", answer: "Yes. Open your booking page and choose Cancel booking. Sessions that have already started cannot be cancelled." },
    { question: "Can an AI agent book for me?", answer: "Yes. Agents use the same booking rules through the public REST API, and need your delegated permission to book on your behalf." },
  ] satisfies Faq[],
  agentNotes: [
    "Reading services, slots and the organization is public and needs no authentication.",
    "Creating, reading and cancelling bookings requires authentication; booking changes also require an Idempotency-Key header.",
    "Errors use RFC 9457 application/problem+json with a stable `code`.",
  ],
} as const;

/** Paths that must never be crawled or listed (also blocked in robots.txt). Not a security control. */
export const PRIVATE_PATHS = ["/api/", "/bookings/"] as const;
