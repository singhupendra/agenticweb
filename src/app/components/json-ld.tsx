import { serializeJsonLd, type JsonLd as JsonLdNode } from "@/agents/discovery/jsonld";

/** Renders one or more JSON-LD nodes. Content is escaped by serializeJsonLd (safe inside <script>). */
export function JsonLd({ data }: { data: JsonLdNode | JsonLdNode[] }) {
  return (
    <>
      {(Array.isArray(data) ? data : [data]).map((node, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(node) }} />
      ))}
    </>
  );
}
