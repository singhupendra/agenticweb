import { problemResponse, AppError } from "@/core/errors";
import { getPrisma } from "@/core/db";
export const dynamic = "force-dynamic";

/** Readiness: dependencies reachable (database). */
export async function GET() {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return Response.json({ status: "ready", checks: { database: "ok" } }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return problemResponse(new AppError("not_ready", "Database is not reachable.", { cause: e }));
  }
}
