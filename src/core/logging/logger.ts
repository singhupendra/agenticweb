export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const REDACT = /^(authorization|cookie|set-cookie|password|token|access_?token|refresh_?token|secret|api_?key|email|x-dev-actor)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
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
      sink(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...(redact({ ...base, ...fields }) as object) }));
    };
    return {
      debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"),
      child: (f) => make({ ...base, ...f }),
    };
  };
  return make(opts.base ?? {});
}

export const nullLogger: Logger = createLogger({ sink: () => {} });
