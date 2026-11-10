export const dynamic = "force-dynamic";
/** Liveness: process is up. Must not touch dependencies. */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
