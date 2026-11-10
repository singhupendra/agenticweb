/** Static, dependency-free HTML rendering of the generated OpenAPI document. Pure; every value is escaped. */
import type { Json, OpenApiDocument } from "./openapi";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const METHODS = ["get", "post", "put", "patch", "delete"];
const pretty = (v: unknown) => `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
const resolveRef = (doc: OpenApiDocument, r: Json): Json => {
  const ref = r.$ref as string | undefined;
  if (!ref) return r;
  return ref.replace("#/", "").split("/").reduce<Json>((o, k) => (o[k] ?? {}) as Json, doc);
};

export function renderDocsHtml(doc: OpenApiDocument): string {
  const info = doc.info as { title: string; version: string; description?: string };
  const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((m) => ({ path, method: m, op: item[m] as Json })),
  );
  const nav = ops.map((o) => `<li><a href="#${esc(o.op.operationId)}"><b>${o.method.toUpperCase()}</b> ${esc(o.path)}</a></li>`).join("");
  const sections = ops.map(({ path, method, op }) => {
    const params = ((op.parameters ?? []) as Json[]).map((p) => resolveRef(doc, p));
    const rows = params
      .map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td>${p.required ? "yes" : "no"}</td><td><code>${esc(JSON.stringify(p.schema))}</code></td></tr>`)
      .join("");
    const body = (op.requestBody as Json | undefined)?.content as Record<string, Json> | undefined;
    const responses = Object.entries((op.responses ?? {}) as Record<string, Json>)
      .map(([code, r]) => `<tr><td><code>${esc(code)}</code></td><td>${esc(resolveRef(doc, r).description)}</td></tr>`)
      .join("");
    return `<section id="${esc(op.operationId)}"><h2><span class="m ${method}">${method.toUpperCase()}</span> <code>${esc(path)}</code></h2>
<p>${esc(op.summary)}</p><p class="muted">${esc(op.description)}</p>
${rows ? `<h3>Parameters</h3><table><tr><th>Name</th><th>In</th><th>Required</th><th>Schema</th></tr>${rows}</table>` : ""}
${body ? `<h3>Request body</h3>${pretty(body["application/json"]?.schema)}` : ""}
<h3>Responses</h3><table><tr><th>Status</th><th>Meaning</th></tr>${responses}</table></section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.title)} — docs</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
code,pre{font:13px ui-monospace,monospace;background:#f4f4f5;border-radius:4px}code{padding:1px 4px}pre{padding:.75rem;overflow:auto}
table{border-collapse:collapse;width:100%;margin:.5rem 0}td,th{border:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top}
.m{font-weight:700;padding:2px 8px;border-radius:4px;color:#fff;background:#555}.get{background:#0a7d3b}.post{background:#1d4ed8}.patch{background:#b45309}.delete{background:#b91c1c}
.muted{color:#555}section{margin:2.5rem 0;border-top:1px solid #eee}nav ul{columns:2;padding-left:1.2rem}</style></head><body>
<h1>${esc(info.title)} <small>v${esc(info.version)}</small></h1><p>${esc(info.description)}</p>
<p><a href="/openapi.json">openapi.json</a> (OpenAPI 3.1, generated from the capability registry)</p>
<nav><ul>${nav}</ul></nav>${sections.join("\n")}</body></html>`;
}
