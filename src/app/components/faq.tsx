import type { Faq as FaqItem } from "@/agents/discovery/content";

/** Visible FAQ. FAQPage JSON-LD is generated from the same items, so markup always matches what users see. */
export function Faq({ items }: { items: readonly FaqItem[] }) {
  return (
    <section aria-labelledby="faq-heading">
      <h2 id="faq-heading" className="text-xl font-semibold">Frequently asked questions</h2>
      <dl className="mt-4 space-y-4">
        {items.map((f) => (
          <div key={f.question}>
            <dt className="font-medium">{f.question}</dt>
            <dd className="mt-1 text-zinc-700">{f.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
