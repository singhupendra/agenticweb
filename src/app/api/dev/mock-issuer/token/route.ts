import { mockTokenResponse } from "@/core/auth/mock-issuer-http";
export const POST = (req: Request) => mockTokenResponse(req);
