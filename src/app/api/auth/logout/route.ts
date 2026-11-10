import { getOidcHandlers } from "@/core/auth";
export const dynamic = "force-dynamic";
const handle = async (request: Request) => (await getOidcHandlers()).logout(request);
export const POST = handle;
export const GET = handle; // → 405
