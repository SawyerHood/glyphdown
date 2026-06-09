import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.ts'

/** The hosted Glyphdown server; override via GLYPHDOWN_SERVER or the config file. */
export const DEFAULT_SERVER_URL = 'https://glyphdown.com'

/** client_id the server's deviceAuthorization plugin accepts (validateClient). */
export const DEVICE_CLIENT_ID = 'glyphdown-cli'

export interface CliConfig {
  serverUrl: string
  apiKey?: string
  /** better-auth session token from `glyphdown login` (device flow); not a gd_sk_ key. */
  sessionToken?: string
}

interface ConfigFile {
  serverUrl?: string
  apiKey?: string
  sessionToken?: string
}

/**
 * GLYPHDOWN_CONFIG_DIR overrides the default location (used by tests).
 * INKROOM_CONFIG_DIR / INKWELL_CONFIG_DIR are the pre-rename names, still
 * honored as silent fallbacks when the new variable is unset.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.GLYPHDOWN_CONFIG_DIR ??
    env.INKROOM_CONFIG_DIR ??
    env.INKWELL_CONFIG_DIR ??
    join(homedir(), '.config', 'glyphdown')
  )
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json')
}

/**
 * Pre-rename default config files (newest rename first), used only for
 * auto-migration: Inkroom, then the original Inkwell.
 */
function legacyDefaultConfigPaths(): string[] {
  return [
    join(homedir(), '.config', 'inkroom', 'config.json'),
    join(homedir(), '.config', 'inkwell', 'config.json'),
  ]
}

/**
 * One-time config migration for the renames: when the new config file is
 * absent, the first existing legacy file (~/.config/inkroom/config.json,
 * else ~/.config/inkwell/config.json) is copied over (mode 600, it holds
 * keys). Skipped when an explicit *_CONFIG_DIR override is set (tests /
 * unusual setups manage their own dir).
 */
function migrateLegacyConfig(env: NodeJS.ProcessEnv): void {
  if (env.GLYPHDOWN_CONFIG_DIR ?? env.INKROOM_CONFIG_DIR ?? env.INKWELL_CONFIG_DIR) return
  const next = configPath(env)
  if (existsSync(next)) return
  const legacy = legacyDefaultConfigPaths().find((path) => existsSync(path))
  if (legacy === undefined) return
  try {
    mkdirSync(configDir(env), { recursive: true })
    copyFileSync(legacy, next)
    chmodSync(next, 0o600)
  } catch {
    // best-effort — a failed copy just means `glyphdown login` is needed again
  }
}

function readConfigFile(env: NodeJS.ProcessEnv): ConfigFile {
  const path = configPath(env)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConfigFile
  } catch {
    return {}
  }
}

/**
 * Credential/server resolution, highest priority first:
 *   1. GLYPHDOWN_API_KEY env (the agent path)
 *   2. GLYPHDOWN_SERVER env
 *   3. ~/.config/glyphdown/config.json (written by `glyphdown login`;
 *      auto-migrated from the pre-rename ~/.config/inkroom/config.json —
 *      else ~/.config/inkwell/config.json — on first run)
 *
 * The pre-rename INKROOM_* (and older INKWELL_*) API_KEY / SERVER variables
 * are still honored as silent fallbacks when the GLYPHDOWN_* ones are unset.
 *
 * apiKey (gd_sk_…, attributes to the agent) and sessionToken (device-flow
 * sign-in, attributes to the human) can coexist; api.ts prefers the key.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  migrateLegacyConfig(env)
  const file = readConfigFile(env)
  return {
    serverUrl: env.GLYPHDOWN_SERVER ?? env.INKROOM_SERVER ?? env.INKWELL_SERVER ?? file.serverUrl ?? DEFAULT_SERVER_URL,
    apiKey: env.GLYPHDOWN_API_KEY ?? env.INKROOM_API_KEY ?? env.INKWELL_API_KEY ?? file.apiKey,
    sessionToken: file.sessionToken,
  }
}

/**
 * Drop stored credentials (keeping serverUrl). Returns what was removed so
 * the caller can best-effort revoke the session server-side.
 */
export function clearCredentials(env: NodeJS.ProcessEnv = process.env): {
  hadApiKey: boolean
  sessionToken?: string
} {
  const file = readConfigFile(env)
  const removed = { hadApiKey: file.apiKey !== undefined, sessionToken: file.sessionToken }
  const next: ConfigFile = file.serverUrl ? { serverUrl: file.serverUrl } : {}
  mkdirSync(configDir(env), { recursive: true })
  writeFileSync(configPath(env), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(configPath(env), 0o600)
  return removed
}

/** Merge a patch into the config file; the file is kept at mode 600 (it holds keys). */
export function writeConfig(patch: ConfigFile, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env)
  mkdirSync(dir, { recursive: true })
  const path = configPath(env)
  const next = { ...readConfigFile(env), ...patch }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync's mode only applies on create; enforce on overwrite too.
  chmodSync(path, 0o600)
  return path
}

// ---------------------------------------------------------------------------
// Device-code sign-in (RFC 8628 against better-auth's deviceAuthorization
// plugin, mounted at <server>/api/auth/device/*)
// ---------------------------------------------------------------------------

interface DeviceCodeGrant {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  /** Seconds until the codes expire. */
  expires_in: number
  /** Minimum seconds between token polls. */
  interval: number
}

interface DeviceTokenError {
  error?: string
  error_description?: string
}

/** Injectable effects so tests run the full flow against a mocked fetch. */
export interface DeviceLoginIO {
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  /** Best-effort browser open; failures are ignored. */
  openUrl?: (url: string) => void
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
}

/** `open` on macOS, `xdg-open` elsewhere; never throws (headless is fine). */
function defaultOpenUrl(url: string): void {
  try {
    const opener = platform() === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // headless / no opener — the printed URL is the fallback
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Interactive sign-in via better-auth Device Authorization (RFC 8628):
 * request device+user codes, print the verification URL (and try to open
 * it), then poll the token endpoint at the server-given interval — honoring
 * `slow_down` (+5s, RFC 8628 §3.5) — until approved/denied/expired. The
 * resulting session token is stored in config.json (mode 600) and returned.
 */
export async function loginWithDeviceCode(serverUrl: string, io: DeviceLoginIO = {}): Promise<string> {
  const fetchFn = io.fetchImpl ?? fetch
  const out = io.out ?? ((line: string) => console.log(line))
  const openUrl = io.openUrl ?? defaultOpenUrl
  const sleep = io.sleep ?? defaultSleep
  const env = io.env ?? process.env
  const base = serverUrl.replace(/\/+$/, '')

  const codeRes = await fetchFn(`${base}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
  })
  if (!codeRes.ok) {
    const detail = (await codeRes.text()).trim().slice(0, 200)
    throw new CliError(
      1,
      `device-code sign-in unavailable at ${base} (HTTP ${codeRes.status}${detail ? `: ${detail}` : ''}).\n` +
        'Use `glyphdown login --key <gd_sk_...>` with a key minted in Settings → Agents, or set GLYPHDOWN_API_KEY.',
    )
  }
  const grant = (await codeRes.json()) as DeviceCodeGrant

  out('To sign in, visit:')
  out(`  ${grant.verification_uri}`)
  out(`and enter the code: ${grant.user_code}`)
  openUrl(grant.verification_uri_complete)

  const deadline = Date.now() + grant.expires_in * 1000
  let intervalMs = Math.max(1, grant.interval) * 1000

  for (;;) {
    await sleep(intervalMs)
    if (Date.now() >= deadline) {
      throw new CliError(1, 'device code expired before approval — run `glyphdown login` again')
    }
    const tokenRes = await fetchFn(`${base}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: DEVICE_CLIENT_ID,
      }),
    })
    const bodyText = await tokenRes.text()

    if (tokenRes.ok) {
      const { access_token } = JSON.parse(bodyText) as { access_token?: string }
      if (!access_token) throw new CliError(1, 'server returned no access token — try again')
      const path = writeConfig({ sessionToken: access_token, serverUrl: base }, env)
      out(`signed in — session saved to ${path} (mode 600)`)
      return access_token
    }

    let parsed: DeviceTokenError = {}
    try {
      parsed = JSON.parse(bodyText) as DeviceTokenError
    } catch {
      // non-JSON error body — handled below as a hard failure
    }
    switch (parsed.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        intervalMs += 5000
        continue
      case 'expired_token':
        throw new CliError(1, 'device code expired before approval — run `glyphdown login` again')
      case 'access_denied':
        throw new CliError(1, 'sign-in was denied in the browser')
      default:
        throw new CliError(
          1,
          `device token request failed (HTTP ${tokenRes.status})${parsed.error_description ? `: ${parsed.error_description}` : ''}`,
        )
    }
  }
}
