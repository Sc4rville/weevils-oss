// Wrong access codes: a pause after each (800 ms, in index.ts), and a ceiling on how many may be tried. Per address
// (x-forwarded-for, set by Caddy), and for the whole machine so that many addresses together get no further. Devices
// already signed in keep their cookie: only new sign-ins wait.
export const PER_ADDRESS = 10
export const GLOBAL = 50
export const WINDOW_MS = 15 * 60_000

export function loginLimiter(now: () => number = Date.now) {
  const fails: { at: number; who: string }[] = []
  const prune = () => {
    const since = now() - WINDOW_MS
    while (fails.length && fails[0].at < since) fails.shift()
  }
  return {
    /** May this address try a code now? */
    allowed(who: string): boolean {
      prune()
      if (fails.length >= GLOBAL) return false
      return fails.filter((f) => f.who === who).length < PER_ADDRESS
    },
    failed(who: string) {
      fails.push({ at: now(), who })
    },
  }
}
