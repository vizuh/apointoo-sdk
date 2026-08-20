// Timing helpers shared across adapters. Internal — not re-exported through
// the public barrel.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
