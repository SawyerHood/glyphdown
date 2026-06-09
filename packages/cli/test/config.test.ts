import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliError, DEVICE_CLIENT_ID, clearCredentials, loginWithDeviceCode, resolveConfig, writeConfig } from '../src/index.ts'

const dirs: string[] = []
function tmpEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'glyphdown-config-test-'))
  dirs.push(dir)
  return { GLYPHDOWN_CONFIG_DIR: dir, ...extra }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('config resolution', () => {
  it('falls back to the config file written by glyphdown login --key', () => {
    const env = tmpEnv()
    writeConfig({ apiKey: 'gd_sk_file', serverUrl: 'https://file.example' }, env)
    const config = resolveConfig(env)
    expect(config.apiKey).toBe('gd_sk_file')
    expect(config.serverUrl).toBe('https://file.example')
  })

  it('GLYPHDOWN_API_KEY and GLYPHDOWN_SERVER take priority over the file', () => {
    const env = tmpEnv({ GLYPHDOWN_API_KEY: 'gd_sk_env', GLYPHDOWN_SERVER: 'https://env.example' })
    writeConfig({ apiKey: 'gd_sk_file', serverUrl: 'https://file.example' }, env)
    const config = resolveConfig(env)
    expect(config.apiKey).toBe('gd_sk_env')
    expect(config.serverUrl).toBe('https://env.example')
  })

  it('legacy INKROOM_* / INKWELL_* env vars are honored as silent fallbacks', () => {
    const env = tmpEnv({ INKROOM_API_KEY: 'ink_sk_old', INKWELL_SERVER: 'https://oldest.example' })
    writeConfig({ apiKey: 'gd_sk_file', serverUrl: 'https://file.example' }, env)
    const config = resolveConfig(env)
    expect(config.apiKey).toBe('ink_sk_old')
    expect(config.serverUrl).toBe('https://oldest.example')
  })

  it('GLYPHDOWN_* wins over legacy INKROOM_* / INKWELL_* when all are set', () => {
    const env = tmpEnv({
      GLYPHDOWN_API_KEY: 'gd_sk_new',
      INKROOM_API_KEY: 'ink_sk_mid',
      INKWELL_API_KEY: 'ink_sk_old',
      GLYPHDOWN_SERVER: 'https://new.example',
      INKROOM_SERVER: 'https://mid.example',
      INKWELL_SERVER: 'https://old.example',
    })
    const config = resolveConfig(env)
    expect(config.apiKey).toBe('gd_sk_new')
    expect(config.serverUrl).toBe('https://new.example')
  })

  it('INKROOM_* wins over the older INKWELL_* when both legacy names are set', () => {
    const env = tmpEnv({
      INKROOM_API_KEY: 'ink_sk_mid',
      INKWELL_API_KEY: 'ink_sk_old',
      INKROOM_SERVER: 'https://mid.example',
      INKWELL_SERVER: 'https://old.example',
    })
    const config = resolveConfig(env)
    expect(config.apiKey).toBe('ink_sk_mid')
    expect(config.serverUrl).toBe('https://mid.example')
  })

  it('legacy INKROOM_CONFIG_DIR and INKWELL_CONFIG_DIR still locate the config file', () => {
    for (const name of ['INKROOM_CONFIG_DIR', 'INKWELL_CONFIG_DIR'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'glyphdown-config-legacy-'))
      dirs.push(dir)
      const env = { [name]: dir } as NodeJS.ProcessEnv
      writeConfig({ apiKey: 'ink_sk_legacy_dir' }, env)
      expect(resolveConfig(env).apiKey).toBe('ink_sk_legacy_dir')
    }
  })

  it('writes the config file with mode 600 and merges patches', () => {
    const env = tmpEnv()
    const path = writeConfig({ apiKey: 'gd_sk_1' }, env)
    writeConfig({ serverUrl: 'https://s.example' }, env)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(stored).toEqual({ apiKey: 'gd_sk_1', serverUrl: 'https://s.example' })
  })

  it('round-trips a sessionToken alongside an apiKey (key wins at the API layer)', () => {
    const env = tmpEnv()
    writeConfig({ sessionToken: 'sess_tok', serverUrl: 'https://s.example' }, env)
    writeConfig({ apiKey: 'gd_sk_1' }, env)
    const config = resolveConfig(env)
    expect(config.sessionToken).toBe('sess_tok')
    expect(config.apiKey).toBe('gd_sk_1')
    expect(config.serverUrl).toBe('https://s.example')
  })
})

// ---------------------------------------------------------------------------
// Device-code login (RFC 8628) against a mocked fetch sequence
// ---------------------------------------------------------------------------

const GRANT = {
  device_code: 'dev-code-123',
  user_code: 'ABCD2345',
  verification_uri: 'https://ink.example/device',
  verification_uri_complete: 'https://ink.example/device?user_code=ABCD2345',
  expires_in: 900,
  interval: 5,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Mock fetch: first call serves the grant, later calls pop `polls`. */
function deviceFetch(polls: Response[]) {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.endsWith('/api/auth/device/code')) return jsonResponse(GRANT)
    const next = polls.shift()
    if (!next) throw new Error('unexpected extra poll')
    return next
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('loginWithDeviceCode', () => {
  it('polls pending -> slow_down (+5s) -> success and stores the token at mode 600', async () => {
    const env = tmpEnv()
    const { fetchImpl, calls } = deviceFetch([
      jsonResponse({ error: 'authorization_pending', error_description: 'pending' }, 400),
      jsonResponse({ error: 'slow_down', error_description: 'too fast' }, 400),
      jsonResponse({ access_token: 'sess_device_tok', token_type: 'Bearer', expires_in: 604800, scope: '' }),
    ])
    const lines: string[] = []
    const sleeps: number[] = []
    const opened: string[] = []

    const token = await loginWithDeviceCode('https://ink.example/', {
      fetchImpl,
      env,
      out: (l) => lines.push(l),
      openUrl: (u) => opened.push(u),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(token).toBe('sess_device_tok')
    // Printed the verification URL + user code, and tried the browser.
    expect(lines.join('\n')).toContain('https://ink.example/device')
    expect(lines.join('\n')).toContain('ABCD2345')
    expect(opened).toEqual(['https://ink.example/device?user_code=ABCD2345'])
    // Server interval honored; slow_down added 5s for the final poll.
    expect(sleeps).toEqual([5000, 5000, 10000])
    // Code request + 3 polls, all with the registered client_id.
    expect(calls).toHaveLength(4)
    expect(calls[0]!.url).toBe('https://ink.example/api/auth/device/code')
    expect(calls[0]!.body).toEqual({ client_id: DEVICE_CLIENT_ID })
    for (const poll of calls.slice(1)) {
      expect(poll.url).toBe('https://ink.example/api/auth/device/token')
      expect(poll.body).toMatchObject({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'dev-code-123',
        client_id: DEVICE_CLIENT_ID,
      })
    }
    // Token stored (mode 600) and resolvable.
    const config = resolveConfig(env)
    expect(config.sessionToken).toBe('sess_device_tok')
    expect(config.serverUrl).toBe('https://ink.example')
    expect(statSync(join(env.GLYPHDOWN_CONFIG_DIR!, 'config.json')).mode & 0o777).toBe(0o600)
  })

  it('fails cleanly when the user denies in the browser', async () => {
    const env = tmpEnv()
    const { fetchImpl } = deviceFetch([
      jsonResponse({ error: 'access_denied', error_description: 'denied' }, 400),
    ])
    await expect(
      loginWithDeviceCode('https://ink.example', {
        fetchImpl,
        env,
        out: () => {},
        openUrl: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrowError(/denied/)
    expect(resolveConfig(env).sessionToken).toBeUndefined()
  })

  it('fails cleanly on expired_token and when the server lacks the endpoints', async () => {
    const env = tmpEnv()
    const { fetchImpl } = deviceFetch([
      jsonResponse({ error: 'expired_token', error_description: 'expired' }, 400),
    ])
    await expect(
      loginWithDeviceCode('https://ink.example', {
        fetchImpl,
        env,
        out: () => {},
        openUrl: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrowError(/expired/)

    const missing = (async () => new Response('not found', { status: 404 })) as typeof fetch
    try {
      await loginWithDeviceCode('https://ink.example', {
        fetchImpl: missing,
        env,
        out: () => {},
        openUrl: () => {},
        sleep: async () => {},
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).message).toMatch(/--key|GLYPHDOWN_API_KEY/)
    }
  })
})

describe('clearCredentials', () => {
  it('removes credentials, keeps serverUrl, and reports what was removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glyphdown-logout-'))
    const env = { GLYPHDOWN_CONFIG_DIR: dir } as NodeJS.ProcessEnv
    writeConfig({ serverUrl: 'https://example.test', apiKey: 'gd_sk_abc', sessionToken: 'sess123' }, env)
    const removed = clearCredentials(env)
    expect(removed).toEqual({ hadApiKey: true, sessionToken: 'sess123' })
    const after = resolveConfig(env)
    expect(after.serverUrl).toBe('https://example.test')
    expect(after.apiKey).toBeUndefined()
    expect(after.sessionToken).toBeUndefined()
  })
})
