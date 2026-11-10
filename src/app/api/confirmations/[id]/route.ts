import { describeConfirmation } from "@/api/confirmations";
export const dynamic = "force-dynamic";
export const GET = (request: Request, ctx: { params: Promise<{ id: string }> }) => describeConfirmation(request, ctx);
