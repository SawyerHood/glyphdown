import { describe, expect, it } from 'vitest'
import { isHtmlCommentsFrameMessage, isHtmlCommentsParentMessage } from './html-comments.ts'

const NONCE = 'test-nonce'

const validAnchor = {
  schema: 1,
  path: [{ tag: 'div', nthOfType: 1 }],
  fingerprint: { tag: 'p' },
  domHint: 3,
  label: 'p "hello"',
  status: 'anchored',
}

const env = (extra: Record<string, unknown>) => ({ version: 1, nonce: NONCE, ...extra })

describe('isHtmlCommentsFrameMessage (untrusted iframe → parent)', () => {
  it('accepts well-formed messages', () => {
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:ready' }), NONCE)).toBe(true)
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:select', anchor: validAnchor }), NONCE)).toBe(true)
    expect(
      isHtmlCommentsFrameMessage(
        env({ t: 'gd:markers-resolved', markers: [{ id: 'a', status: 'anchored', domHint: 1, label: 'x' }] }),
        NONCE,
      ),
    ).toBe(true)
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:marker-click', id: 'abc' }), NONCE)).toBe(true)
  })

  it('rejects wrong nonce / envelope', () => {
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:ready' }), 'other')).toBe(false)
    expect(isHtmlCommentsFrameMessage({ version: 2, nonce: NONCE, t: 'gd:ready' }, NONCE)).toBe(false)
    expect(isHtmlCommentsFrameMessage(null, NONCE)).toBe(false)
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:unknown' }), NONCE)).toBe(false)
  })

  it('rejects malformed payloads a forged author script could send', () => {
    // anchor not a valid NodeAnchor shape
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:select', anchor: { schema: 2 } }), NONCE)).toBe(false)
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:select', anchor: 'nope' }), NONCE)).toBe(false)
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:select' }), NONCE)).toBe(false)
    // markers not an array / element missing id / bad status
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:markers-resolved', markers: 'x' }), NONCE)).toBe(false)
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:markers-resolved', markers: [{ status: 'anchored' }] }), NONCE)).toBe(false)
    expect(
      isHtmlCommentsFrameMessage(env({ t: 'gd:markers-resolved', markers: [{ id: 'a', status: 'maybe' }] }), NONCE),
    ).toBe(false)
    // oversized array is rejected
    const huge = Array.from({ length: 5001 }, (_, i) => ({ id: String(i), status: 'anchored' as const }))
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:markers-resolved', markers: huge }), NONCE)).toBe(false)
    // marker-click id must be a string
    expect(isHtmlCommentsFrameMessage(env({ t: 'gd:marker-click', id: 42 }), NONCE)).toBe(false)
  })
})

describe('isHtmlCommentsParentMessage', () => {
  it('accepts valid and rejects invalid', () => {
    expect(isHtmlCommentsParentMessage(env({ t: 'gd:set-mode', mode: 'pick' }), NONCE)).toBe(true)
    expect(isHtmlCommentsParentMessage(env({ t: 'gd:set-mode', mode: 'nope' }), NONCE)).toBe(false)
    expect(isHtmlCommentsParentMessage(env({ t: 'gd:set-markers', markers: [{ id: 'a', anchor: validAnchor }] }), NONCE)).toBe(true)
    expect(isHtmlCommentsParentMessage(env({ t: 'gd:set-markers', markers: [{ id: 'a' }] }), NONCE)).toBe(false)
    expect(isHtmlCommentsParentMessage(env({ t: 'gd:focus-marker', id: 'x' }), NONCE)).toBe(true)
  })
})
