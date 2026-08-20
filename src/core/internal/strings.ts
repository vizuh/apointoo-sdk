// Tiny string helpers shared across adapters. Internal — not re-exported
// through the public barrel. Adapter authors import directly.

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
