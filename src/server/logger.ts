// PII-safe logger. Pattern 14 enforced at the type level.
// Adapters and pipeline log through this — never `console.log` directly.

import type { LogEvent, LogLevel, Logger } from '../core/types.js'
import { APOINTOO_HEADLESS_VERSION } from '../core/version.js'

export type ConsoleLoggerOptions = {
  /** Min level. Default: 'info'. */
  minLevel?: LogLevel
  /** Override sink for tests. */
  sink?: (line: string) => void
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function consoleLogger(opts: ConsoleLoggerOptions = {}): Logger {
  const minLevel = opts.minLevel ?? 'info'
  const minLevelOrder = ORDER[minLevel]
  const sink = opts.sink ?? defaultSink

  function emit(level: LogLevel, e: Omit<LogEvent, 'level'>): void {
    if (ORDER[level] < minLevelOrder) return
    const line = JSON.stringify({
      level,
      ts: new Date().toISOString(),
      version: APOINTOO_HEADLESS_VERSION,
      ...e,
    })
    sink(line)
  }

  return {
    debug: (e) => emit('debug', e),
    info: (e) => emit('info', e),
    warn: (e) => emit('warn', e),
    error: (e) => emit('error', e),
  }
}

function defaultSink(line: string): void {
  // Single channel — error level uses console.error, else console.log.
  // Vercel logs route both correctly.
  if (line.includes('"level":"error"')) {
    console.error(line)
  } else {
    console.log(line)
  }
}

/** Compose a logger with extra context merged into every event. */
export function withContext(
  base: Logger,
  defaults: Pick<LogEvent, 'submissionId' | 'vendor'>,
): Logger {
  function merge<T extends Omit<LogEvent, 'level'>>(e: T): T {
    return { ...defaults, ...e }
  }
  return {
    debug: (e) => base.debug(merge(e)),
    info: (e) => base.info(merge(e)),
    warn: (e) => base.warn(merge(e)),
    error: (e) => base.error(merge(e)),
  }
}

/** Bound stack to first 5 frames for logging. */
export function boundedStack(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined
  return err.stack.split('\n').slice(0, 5).join('\n')
}
