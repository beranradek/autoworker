export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

