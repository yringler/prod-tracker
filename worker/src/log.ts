// Structured logging for Workers Logs. Each call emits ONE JSON line; the
// Cloudflare dashboard (Logs Explorer) indexes the fields so you can filter and
// aggregate by them (e.g. level=error, or all lines for one runId). We avoid
// Pino/Winston on purpose — they assume Node streams / process.stdout and don't
// belong on Workers; console.log(JSON.stringify(...)) is the native pattern and
// is already captured by [observability.logs] in wrangler.toml.

type Fields = Record<string, unknown>;
type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Derive a logger that merges `base` into every line (e.g. a per-tick runId). */
  child(base: Fields): Logger;
}

function emit(level: Level, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...fields });
  // Route by level so Cloudflare's own severity classification matches ours.
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function make(base: Fields): Logger {
  const at = (level: Level) => (msg: string, fields?: Fields) =>
    emit(level, msg, base || fields ? { ...base, ...fields } : undefined);
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (more: Fields) => make({ ...base, ...more }),
  };
}

export const log: Logger = make({});

/**
 * Normalize a caught value into log fields. Never log raw Error objects — their
 * stack/message don't survive JSON.stringify, so extract them explicitly.
 */
export function errFields(e: unknown): Fields {
  if (e instanceof Error) {
    return { err: { name: e.name, message: e.message, stack: e.stack } };
  }
  return { err: String(e) };
}
