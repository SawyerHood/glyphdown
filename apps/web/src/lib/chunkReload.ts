/**
 * Deploy-skew self-healing: every deploy replaces the hashed route/editor
 * chunks (Cloudflare Workers assets serve only the current deployment), so a
 * tab opened before the deploy 404s the moment it lazy-loads anything new —
 * and without this, every navigation in that tab is dead until a manual
 * reload. Vite's preload helper reports exactly that failure as a
 * `vite:preloadError` window event; reloading swaps in the fresh HTML (new
 * chunk hashes) at the URL the user was already navigating to.
 *
 * The sessionStorage stamp breaks reload loops: if a chunk is missing for a
 * real reason (broken deploy, blocked CDN), one automatic reload is attempted
 * and the next failure within the window surfaces instead of cycling forever.
 */

const STAMP_KEY = 'glyphdown:chunk-reload-at'
const LOOP_WINDOW_MS = 30_000

export function installChunkReloadHandler(): void {
  window.addEventListener('vite:preloadError', (event) => {
    let last = 0
    try {
      last = Number(window.sessionStorage.getItem(STAMP_KEY) ?? 0)
    } catch {
      // sessionStorage unavailable — still reload; the loop guard just degrades.
    }
    if (Date.now() - last < LOOP_WINDOW_MS) return // let the error surface
    try {
      window.sessionStorage.setItem(STAMP_KEY, String(Date.now()))
    } catch {
      // best-effort
    }
    event.preventDefault()
    window.location.reload()
  })
}
