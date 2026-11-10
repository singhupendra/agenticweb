/**
 * Tool results contain website/user-authored text (service names, notes). That text is DATA, never instructions.
 * We cannot reliably detect "instruction-like" prose, so we remove the carriers attackers rely on instead:
 * invisible/bidi characters (hidden text), control characters, and markup/delimiter characters that imitate
 * system/tool-call boundaries; and we length-limit. Callers also flag results with `_meta["agenticweb/untrusted"]`.
 */
export const MAX_TEXT_LENGTH = 500;

/** Code-point ranges (inclusive) that are removed: C0/C1 controls, soft hyphen, zero-width, bidi marks/embeddings/isolates, BOM, tag characters. */
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f],
];
const stripped = (cp: number) => STRIP_RANGES.some(([a, b]) => cp >= a && cp <= b);
const DELIMS: Record<string, string> = { "<": "‹", ">": "›", "`": "'" };

export function sanitizeText(s: string): string {
  let out = "";
  for (const ch of s) {
    if (stripped(ch.codePointAt(0) as number)) continue;
    out += DELIMS[ch] ?? ch;
  }
  const clean = out.replace(/\s{2,}/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > MAX_TEXT_LENGTH ? `${chars.slice(0, MAX_TEXT_LENGTH - 1).join("")}…` : clean;
}

export function sanitizeUntrusted<T>(value: T): T {
  if (typeof value === "string") return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeUntrusted) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeUntrusted(v)])) as T;
  }
  return value;
}
