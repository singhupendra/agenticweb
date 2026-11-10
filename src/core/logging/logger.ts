export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Keys whose values are never logged (substring match, case-insensitive: idToken, clientSecret, X-API-Key, ...). */
const REDACT = /(authorization|cookie|passw(or)?d|token|secret|api[-_]?key|session|credential|signature|e-?mail|phone|full_?name|first_?name|last_?name|x-dev-actor)/i;

const SCRUBBERS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]"], // JWT
  [/([?&;]\s*(?:access_?token|refresh_?token|id_?token|token|api_?key|apikey|key|code|secret|password|sig|signature)=)[^&\s"']+/gi, "$1[redacted]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[redacted]"], // e-mail address
  [/\b(?:postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/[^\s"']+/gi, "[redacted]"], // connection strings with credentials
];

/** Removes token-, e-mail- and credential-shaped substrings from free text. */
export function scrubString(input: string): string {
  return SCRUBBERS.reduce((s, [re, rep]) => s.replace(re, rep), input);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, REDACT.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}

export type LogSink = (line: string) => void;

export function createLogger(opts: { level?: LogLevel; sink?: LogSink; base?: Record<string, unknown> } = {}): Logger {
  const level = opts.level ?? "info";
  const sink: LogSink = opts.sink ?? ((l) => process.stdout.write(l + "\n"));
  const make = (base: Record<string, unknown>): Logger => {
    const emit = (lvl: LogLevel) => (msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[lvl] < ORDER[level]) return;
      sink(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg: scrubString(msg), ...(redact({ ...base, ...fields }) as object) }));
    };
    return {
      debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"),
      child: (f) => make({ ...base, ...f }),
    };
  };
  return make(opts.base ?? {});
}

export const nullLogger: Logger = createLogger({ sink: () => {} });
