export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | undefined>;

export type Logger = {
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

/**
 * Structured logs with a strict convention: callers never pass company names,
 * query text, URLs, tokens, or provider payloads. Only operational metadata.
 */
export function createLogger(level: LogLevel, sink: (line: string) => void = console.log): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const write = (entryLevel: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entryLevel,
      event,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) record[key] = value;
    }
    sink(JSON.stringify(record));
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
