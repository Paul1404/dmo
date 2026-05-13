type Level = "debug" | "info" | "warn" | "error";

type Context = Record<string, unknown>;

const SERVICE = process.env.RAILWAY_SERVICE_NAME ?? "dmo";

function emit(level: Level, message: string, context?: Context): void {
  const entry: Record<string, unknown> = {
    level,
    severity: level,
    message,
    timestamp: new Date().toISOString(),
    service: SERVICE,
  };
  if (context) {
    for (const [k, v] of Object.entries(context)) {
      if (k in entry) continue;
      entry[k] = v instanceof Error ? serializeError(v) : v;
    }
  }
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function serializeError(err: Error): Record<string, unknown> {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...((err as unknown as { status?: number }).status !== undefined
      ? { status: (err as unknown as { status?: number }).status }
      : {}),
  };
}

export const log = {
  debug: (message: string, context?: Context) => emit("debug", message, context),
  info: (message: string, context?: Context) => emit("info", message, context),
  warn: (message: string, context?: Context) => emit("warn", message, context),
  error: (message: string, context?: Context) => emit("error", message, context),
};
