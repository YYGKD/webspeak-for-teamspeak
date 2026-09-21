import pino from "pino";
import { appendFile, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { Writable } from "node:stream";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_LOGS = 3;

export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

/**
 * Minimum level written to the log.
 *
 * Defaults to "debug" — the value that used to be hardcoded — so existing
 * deployments keep the same output. WEBSPEAK_LOG_LEVEL lets an operator turn the
 * per-frame diagnostics down (or up) without a rebuild; an unrecognised value
 * falls back to the default instead of silencing the log.
 */
export function resolveLogLevel(): string {
  const raw = process.env.WEBSPEAK_LOG_LEVEL?.trim().toLowerCase();
  return raw && (LOG_LEVELS as readonly string[]).includes(raw) ? raw : "debug";
}

export function createLogger(logDir?: string): Logger {
  const loggerOptions = {
    level: resolveLogLevel(),
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["password", "*.password", "serverPassword", "*.serverPassword", "token", "*.token", "identity", "*.identity"],
      censor: "[Redacted]",
    },
  };
  const baseLogger = logDir
    ? createFileLogger(loggerOptions, `${logDir}/webspeak.log`)
    : pino(loggerOptions, pino.destination(1));

  function wrap(l: pino.Logger): Logger {
    function doLog(
      level: "debug" | "info" | "warn" | "error",
      objOrMsg: Record<string, unknown> | string,
      msg?: string,
    ): void {
      if (typeof objOrMsg === "string") {
        l[level](objOrMsg);
      } else {
        l[level](objOrMsg, msg);
      }
    }

    return {
      debug: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("debug", objOrMsg, msg),
      info: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("info", objOrMsg, msg),
      warn: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("warn", objOrMsg, msg),
      error: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("error", objOrMsg, msg),
      child: (bindings: Record<string, unknown>) => wrap(l.child(bindings)),
    };
  }

  return wrap(baseLogger);
}

function createFileLogger(options: { level: string; timestamp: typeof pino.stdTimeFunctions.isoTime }, logPath: string): pino.Logger {
  mkdirSync(logPath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  return pino(options, pino.multistream([
    { level: "info", stream: process.stdout },
    // The file gets everything the configured level allows; hardcoding "debug"
    // here silently dropped trace-level records when an operator raised it.
    { level: options.level, stream: new RotatingFileStream(logPath) },
  ]));
}

class RotatingFileStream extends Writable {
  private bytes: number;

  constructor(private readonly filePath: string) {
    super();
    this.bytes = existsSync(filePath) ? statSync(filePath).size : 0;
    if (this.bytes >= MAX_LOG_BYTES) this.rotate();
  }

  override _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    try {
      if (this.bytes + buffer.length > MAX_LOG_BYTES) this.rotate();
      appendFile(this.filePath, buffer, (error) => {
        if (!error) this.bytes += buffer.length;
        callback(error);
      });
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rotate(): void {
    for (let index = MAX_ROTATED_LOGS - 1; index >= 1; index--) {
      const source = `${this.filePath}.${index}`;
      const destination = `${this.filePath}.${index + 1}`;
      if (existsSync(source)) renameSync(source, destination);
    }
    if (existsSync(this.filePath)) renameSync(this.filePath, `${this.filePath}.1`);
    this.bytes = 0;
  }
}
