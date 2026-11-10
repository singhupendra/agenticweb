/** Request-size limit: never buffers more than `maxBytes`, even when content-length is absent or lies. */
import { AppError } from "../errors";

export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
  opts: { requireJson?: boolean } = {},
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw tooLarge(maxBytes);
  if (!request.body) return "";
  if (opts.requireJson) {
    const ct = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!/^application\/(json|[\w.+-]+\+json)(;|$)/.test(ct)) {
      throw new AppError("unsupported_media_type", "Content-Type must be application/json.");
    }
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

const tooLarge = (max: number) => new AppError("payload_too_large", `Request body exceeds ${max} bytes.`);
