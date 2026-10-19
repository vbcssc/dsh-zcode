#!/usr/bin/env node
/**
 * unit-situation.mjs — the situational layer's pure functions, plus a proof that the
 * interpolation hazard they defend against is real.
 *
 * The proof runs against the shipped `renderContextSections` from
 * `@deepseek-ai/dsh-system-prompt` rather than a local reimplementation: a guard
 * tested against a mock of the thing it guards is not a guard. Resolution goes
 * through the installation the bundle will actually run against (a `node_modules`
 * junction to the global dsh store — a development convenience, not part of the
 * package).
 *
 * What it checks, in order:
 *   1. a raw `{{name}}` group in a context text throws, and so does an unmatched
 *      `{{` that has a later `}}` — the two failure paths of `interpolate()`;
 *   2. `braceSafe()` turns both into ordinary prose;
 *   3. a real repository probe against this bundle's own git directory renders a
 *      block carrying the branch, the status listing and recent commits;
 *   4. a fixture repository whose status line contains `{{item}}.hbs` renders, is
 *      guard-passed, and then survives the SHIPPED interpolator — the exact case that
 *      would otherwise kill the whole request;
 *   5. a non-repository directory contributes nothing (empty string, which the
 *      context channel drops);
 *   6. `gitMaxChars` truncates the status listing with the notice line;
 *   7. the date block is stable within a day and the environment block names the
 *      terminal tool the composition actually mounted.
 *
 * The fixture repo is created under `scripts/.probe-fixture` and removed at the end.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'

import {
  braceSafe, dateBlock, environmentBlock, repositoryBlock,
} from '../src/situation.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'scripts', '.probe-fixture')

/**
 * The same values {@link Config} defaults to, spelled out: defaulting is validated by
 * cordis when the row mounts (which `verify-mount.mjs` boots for real), and re-deriving
 * it here would only test a second copy of the same numbers.
 */
const config = { environment: true, git: true, date: true, gitTimeoutMs: 3000, gitMaxChars: 2000, cacheMs: 20000 }

const failures = []
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  process.stdout.write(line + '\n')
  if (!ok) failures.push(line)
}

/** Render one text through the shipped interpolator, reporting a throw as `#throw`. */
const throughShippedInterpolator = text => {
  try {
    return renderContextSections({ contexts: [{ name: 'unit', text }], variables: { model: 'unit-model' } })
      .map(section => section.text).join('')
  } catch (error) {
    return `#throw ${error.message.split('\n')[0].slice(0, 90)}`
  }
}

// ── 1 · the hazard is real: two distinct throw paths ────────────────────────────
const unknown = throughShippedInterpolator('a file named {{item}}.hbs changed')
check('raw `{{name}}` in a context text makes the shipped interpolator throw',
  unknown.startsWith('#throw') && unknown.includes('unknown prompt variable'), unknown)
const malformed = throughShippedInterpolator('unopened {{ and a closer }} later')
check('an `{{` with a later `}}` throws as malformed too',
  malformed.startsWith('#throw') && malformed.includes('malformed prompt variable'), malformed)
check('a lone `{{` with no closer is literal prose (the guard must not overreach)',
  !throughShippedInterpolator('braces {{ here').startsWith('#throw'))

// ── 2 · the guard covers both, and keeps the text readable ──────────────────────
check('braceSafe neutralises both shapes',
  throughShippedInterpolator(braceSafe('a file named {{item}}.hbs changed')) === 'a file named { {item}}.hbs changed'
    && !throughShippedInterpolator(braceSafe('unopened {{ and a closer }} later')).startsWith('#throw'),
  braceSafe('{{item}}'))
check('braceSafe leaves ordinary text untouched', braceSafe('no braces at all') === 'no braces at all')

// ── 3 · a real probe against a real repository ─────────────────────────────────
const dshRepo = resolve(ROOT, '..', 'deepseek-harness')
const block = repositoryBlock(dshRepo, config)
check('repository block on the dsh checkout names the branch',
  /^Current branch: \S+/m.test(block), block.split('\n').find(l => l.startsWith('Current branch')) ?? 'absent')
check('repository block carries the status listing and recent commits',
  block.includes('Status (short form') && block.includes('Recent commits:'),
  `${block.length} chars`)
check('repository block has no live `{{` group anywhere',
  !/\{\{/.test(block), `${(block.match(/\{\{/g) ?? []).length} occurrences`)

// ── 4 · the fixture: a repository whose status really contains `{{` ─────────────
rmSync(FIXTURE, { recursive: true, force: true })
mkdirSync(FIXTURE, { recursive: true })
const git = args => execFileSync('git', args, { cwd: FIXTURE, encoding: 'utf8' })
git(['init', '-q'])
git(['config', 'user.email', 'probe@example.invalid'])
git(['config', 'user.name', 'probe'])
writeFileSync(join(FIXTURE, 'tracked.txt'), 'committed first\n')
git(['add', '-A'])
git(['commit', '-qm', 'probe fixture'])
// The brace-bearing name must be UNTRACKED: a committed path never appears in
// `git status --short`, which is the only listing this block renders.
writeFileSync(join(FIXTURE, '{{item}}.hbs'), 'template\n')
const rawStatus = git(['--no-optional-locks', 'status', '--short'])
const fixtureBlock = repositoryBlock(FIXTURE, config)
check('the raw probe really returns the brace-bearing filename',
  rawStatus.includes('{{item}}.hbs'), rawStatus.trim())
check('repositoryBlock guards it: no live `{{` survives into the block',
  !/\{\{/.test(fixtureBlock) && fixtureBlock.includes('{ {item}}.hbs'),
  fixtureBlock.split('\n').find(l => l.includes('.hbs')) ?? 'filename absent from block')
check('guard-passed fixture block survives the shipped interpolator',
  !throughShippedInterpolator(fixtureBlock).startsWith('#throw'))
check('the RAW probe output would kill the request (the guard is load-bearing)',
  throughShippedInterpolator(rawStatus).startsWith('#throw'))

// ── 5 · a non-repository contributes nothing ────────────────────────────────────
// Verified outside git: this directory has no repository above it.
const elsewhere = resolve(ROOT, '..', 'conduct-dsh')
check('a directory outside any repository yields an empty block',
  repositoryBlock(elsewhere, config) === '',
  `${repositoryBlock(elsewhere, config).length} chars from ${elsewhere}`)

// ── 6 · truncation ──────────────────────────────────────────────────────────────
const tiny = { ...config, gitMaxChars: 12 }
check('gitMaxChars truncates the status listing with a notice',
  /truncated at 12 characters/.test(repositoryBlock(dshRepo, tiny)),
  repositoryBlock(dshRepo, tiny).split('\n').find(l => l.includes('truncated')) ?? 'no notice')

// ── 7 · the stable blocks ───────────────────────────────────────────────────────
const iso = dateBlock(new Date('2026-10-16T23:30:00'))
check('date block is date-resolution only', iso === "Today's date is 2026-10-16 (local time).", iso)
check('date block is stable across calls inside one day', dateBlock() === dateBlock())
const env = environmentBlock(dshRepo, true)
const expectedTerminal = process.platform === 'win32'
  ? 'bash (POSIX shell syntax; the pwsh tool is not mounted)'
  : 'bash'
check('environment block names the terminal tool this bundle mounts (bash on every platform)',
  env.includes(`Terminal tool: ${expectedTerminal}`),
  env.split('\n').find(l => l.startsWith('Terminal tool')) ?? 'absent')
// The block must not show any capitalized spelling of a tool name: the registry is
// case-sensitive and the model copies what the prompt shows.
check('environment block contains no capitalized tool spelling',
  !/\bBash\b|\bPwsh\b|\bPWsh\b/.test(env),
  env.match(/\bBash\b|\bPwsh\b|\bPWsh\b/)?.[0] ?? 'clean')
check('environment block does not restate the working directory (the persona suffix owns it)',
  !/[Ww]orking directory/.test(env), `${env.length} chars`)

rmSync(FIXTURE, { recursive: true, force: true })
process.stdout.write(`\nunit-situation: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`}\n`)
if (failures.length > 0) process.exitCode = 1
