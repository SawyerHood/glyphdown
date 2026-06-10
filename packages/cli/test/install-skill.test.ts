import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProgram } from '../src/index.ts'
import { SKILL_MD } from '../src/skill-content.gen.ts'

function harness(dir: string) {
  const lines: string[] = []
  const program = createProgram({
    env: {},
    cwd: () => dir,
    // Default-target installs land in <tmp>/home, never the real home dir.
    home: () => join(dir, 'home'),
    out: (l) => lines.push(l),
    err: () => {},
  })
  return { lines, run: (args: string[]) => program.parseAsync(args, { from: 'user' }).then(() => undefined) }
}

describe('glyphdown install-skill', () => {
  it('embedded skill matches skills/glyphdown/SKILL.md (run `pnpm gen:skill` if this fails)', () => {
    const source = readFileSync(join(__dirname, '../../../skills/glyphdown/SKILL.md'), 'utf8')
    expect(SKILL_MD).toBe(source)
  })

  it('writes SKILL.md into <dir>/glyphdown/ and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-skill-'))
    const h = harness(dir)
    await h.run(['install-skill', '--dir', dir])
    const installed = join(dir, 'glyphdown', 'SKILL.md')
    expect(readFileSync(installed, 'utf8')).toBe(SKILL_MD)
    expect(h.lines[0]).toContain(installed)

    // Second run overwrites in place without erroring.
    await h.run(['install-skill', '--dir', dir])
    expect(readFileSync(installed, 'utf8')).toBe(SKILL_MD)
  })

  it('resolves --dir relative to the cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-skill-rel-'))
    const h = harness(dir)
    await h.run(['install-skill', '--dir', 'nested/skills'])
    expect(readFileSync(join(dir, 'nested/skills/glyphdown/SKILL.md'), 'utf8')).toBe(SKILL_MD)
  })

  it('without --dir installs to ~/.claude, ~/.codex, and ~/.agents skills dirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-skill-home-'))
    const h = harness(dir)
    await h.run(['install-skill'])
    expect(readFileSync(join(dir, 'home/.claude/skills/glyphdown/SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(readFileSync(join(dir, 'home/.codex/skills/glyphdown/SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(readFileSync(join(dir, 'home/.agents/skills/glyphdown/SKILL.md'), 'utf8')).toBe(SKILL_MD)
  })

  it('--claude / --codex / --agents narrow the default targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-skill-claude-'))
    const h = harness(dir)
    await h.run(['install-skill', '--claude'])
    expect(readFileSync(join(dir, 'home/.claude/skills/glyphdown/SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(existsSync(join(dir, 'home/.codex'))).toBe(false)
    expect(existsSync(join(dir, 'home/.agents'))).toBe(false)

    const dir2 = mkdtempSync(join(tmpdir(), 'gd-skill-codex-'))
    const h2 = harness(dir2)
    await h2.run(['install-skill', '--codex'])
    expect(readFileSync(join(dir2, 'home/.codex/skills/glyphdown/SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(existsSync(join(dir2, 'home/.claude'))).toBe(false)
  })

  it('guide prints the skill body without frontmatter', async () => {
    const h = harness(mkdtempSync(join(tmpdir(), 'gd-guide-')))
    await h.run(['guide'])
    const text = h.lines.join('\n')
    expect(text).toContain('# Glyphdown')
    expect(text).not.toContain('name: glyphdown')
  })
})
