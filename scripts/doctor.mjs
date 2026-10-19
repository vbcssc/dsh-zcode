#!/usr/bin/env node
/**
 * doctor.mjs — the drift gate for the generated patch. Everything here is decidable
 * from files on disk: no dsh boot, no coupling to any other repository.
 *
 * Two distinct failures must not be confused, so they are reported separately:
 *
 *   - LOCAL drift: `cordis.patch.yml` no longer equals what the generator produces from
 *     `text/`. Cause is a hand edit to the generated file, or an edit to the persona text
 *     without re-running `npm run preset`. Fix is `npm run preset`.
 *   - UPSTREAM drift: the shipped dsh standard preset has changed since generation,
 *     recorded by source SHA-256 in the patch header. The patch is still internally
 *     consistent but now restates an outdated child list, so the profile may mount
 *     tools the shipped standard no longer does. Fix is to re-run `npm run preset`
 *     against the new checkout and re-measure.
 *
 * It then re-checks the three properties the preset's correctness rests on: the
 * restated child list still contains every shipped standard row, the persona prefix
 * equals `text/persona.md` byte for byte, and the persona references only prompt
 * variables the harness actually supplies. What needs a live boot — activation, the
 * tool roster, the assembled contexts, peer-version parity — is `verify-mount.mjs`.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  assertFilterNames, PERSONA_FILE, PRESET_PATH, ROOT, render, standardPlugins, standardSource,
} from './make-preset.mjs'
import {
  delegationRows as layerDelegationRows, topRows as layerTopRows, SUBAGENT_PERSONAS, personaSource,
} from './layers.mjs'

const failures = []
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  process.stdout.write(line + '\n')
  if (!ok) failures.push(line)
}

const persona = readFileSync(PERSONA_FILE, 'utf8')
const committed = readFileSync(PRESET_PATH, 'utf8')
const { repo, file } = standardSource()
const sourceText = readFileSync(file, 'utf8')
const plugins = standardPlugins(sourceText)

// ── LOCAL drift: does the committed patch still equal the generator's output? ───
// Recomputed with the same layer rows the generator uses, otherwise this gate would
// report the bundle's own appended rows as someone's hand edit.
const rows = layerDelegationRows()
const fresh = render({ plugins, persona, delegationRows: rows, topRows: layerTopRows(), sourceText, repo })
const headerless = text => text.split('\n').filter(line => !line.startsWith('#')).join('\n')
check('patch equals generator output (no hand edit, no stale persona text)',
  headerless(committed) === headerless(fresh),
  headerless(committed) === headerless(fresh) ? '' : 'run: npm run preset')

// ── UPSTREAM drift: has the shipped standard moved since generation? ────────────
const recorded = committed.match(/^#   source sha256: ([0-9a-f]{64})$/m)?.[1]
const current = createHash('sha256').update(sourceText).digest('hex')
check('shipped dsh standard unchanged since generation',
  recorded !== undefined && recorded === current,
  recorded === undefined ? 'no sha recorded' : `recorded ${recorded.slice(0, 12)} vs now ${current.slice(0, 12)}`)

// ── the load-bearing properties ─────────────────────────────────────────────────
const ids = text => [...text.matchAll(/^ {10}- id: (\S+)$/gm)].map(m => m[1])
check('every shipped standard child row is restated',
  ids(plugins).every(id => ids(committed).includes(id)),
  `standard ${ids(plugins).length} rows, patch has ${ids(committed).length}`)

const embedded = committed.match(/^ {14}prefix: \|-\n((?: {16}.*(?:\n|$|)*)+)/m)?.[1]
  ?.split('\n').map(line => line.slice(16)).join('\n').replace(/\s+$/, '')
check('persona prefix equals text/persona.md byte for byte',
  embedded === persona.replace(/\s+$/, ''),
  embedded === undefined ? 'no block scalar found'
    : `${embedded?.length ?? 0} vs ${persona.trim().length} chars`)

// renderPrompt throws on an unresolvable `{{name}}`, so an unknown variable in the
// persona is a whole-request failure, not a cosmetic one.
const used = [...new Set([...persona.matchAll(/\{\{([^{}]*)\}\}/g)].map(m => m[1]))]
check('persona references only prompt variables the harness supplies',
  used.every(name => name === 'model' || name === 'cwd'),
  used.length === 0 ? 'no variables' : used.join(', '))

// ── named subagents ───────────────────────────────────────────────────────────────
// The same generation-time gate the generator applies, re-run here so a patch edited
// outside `npm run preset` cannot introduce a filter name the live standard lacks.
let rosterError = ''
try {
  assertFilterNames(rows)
} catch (error) {
  rosterError = error.message
}
check('every static subagent filter name is in the recorded live roster',
  rosterError === '', rosterError)

const toolNames = [...committed.matchAll(/^ {18}toolName: (\S+)$/gm)].map(m => m[1])
// The shipped standard declares four of its own (`subagent`, `_fork`, `_codex`,
// `_claude_code`); this check is about this bundle's additions, not about their count.
const ours = SUBAGENT_PERSONAS.map(name => `subagent_${name}`)
check('each named subagent reaches the model under its own tool name, used once',
  ours.every(name => toolNames.includes(name))
    && ours.every(name => toolNames.filter(entry => entry === name).length === 1),
  `bundle rows ${ours.join(', ')} among ${toolNames.length} toolName entries`)

/** Pull each `persona: |-` block scalar body back out of the generated file. */
const personaBodies = []
{
  let current = null
  for (const line of committed.split('\n')) {
    if (line === '                  persona: |-') {
      current = []
      personaBodies.push(current)
      continue
    }
    if (current === null) continue
    if (line.startsWith('                    ')) current.push(line.slice(20))
    else if (line.trim() === '') current.push('')
    else current = null
  }
}
const personaDrift = SUBAGENT_PERSONAS
  .map((name, index) => {
    const source = personaSource(name)
    const body = personaBodies[index]?.join('\n').replace(/\s+$/, '')
    return body === source ? undefined : `${name}: ${body === undefined ? 'block absent' : `${body.length} vs ${source.length} chars`}`
  })
  .filter(entry => entry !== undefined)
check('each subagent persona equals its text/personas source byte for byte',
  personaDrift.length === 0 && personaBodies.length === SUBAGENT_PERSONAS.length,
  personaDrift.join(', ') || SUBAGENT_PERSONAS.map(name => `${name} ${personaSource(name).length}`).join(', '))

// The patch inverts the shipped shell gates: `tool-bash` is enabled on every platform
// and `tool-pwsh` on none. A regression back to the shipped `!!js` conditions would put
// the mode on PowerShell on Windows, which is exactly what the inversion exists to
// prevent, so the two gates are asserted by name as well as by the byte-equality check.
const gateOf = id => committed.match(
  new RegExp(`^ {10}- id: ${id}\\n {12}name: [^\\n]*\\n {12}disabled: (\\S+)`, 'm'))?.[1]
check('the preset inverts the shipped shell gates (bash enabled everywhere, pwsh nowhere)',
  gateOf('tool-bash') === 'false' && gateOf('tool-pwsh') === 'true',
  `tool-bash: ${gateOf('tool-bash') ?? 'row not found'}, tool-pwsh: ${gateOf('tool-pwsh') ?? 'row not found'}`)

// The mode mounts `bash` on every platform, so the subagent's static shell allowance is
// correct on all platforms; a conditional or a `pwsh` allowance would mean the
// inversion regressed.
const staticBash = committed.match(/^ {22}- bash$/gm) ?? []
const conditionalShell = committed.match(/^ {22}- !!js/g) ?? []
const pwshAllowance = committed.match(/^ {22}- pwsh$/gm) ?? []
check('the subagent shell allowance is the statically mounted bash tool',
  staticBash.length === 1 && conditionalShell.length === 0 && pwshAllowance.length === 0,
  `${staticBash.length} static bash, ${conditionalShell.length} conditional, ${pwshAllowance.length} pwsh`)

// A named subagent's tool description is the shipped generic wording — identical for
// every row (measured by `verify-mount.mjs`) — so the persona is the only surface where
// the model learns what each named subagent is for.
check('persona names each named subagent exactly once',
  SUBAGENT_PERSONAS.every(name => persona.split(`subagent_${name}`).length - 1 === 1),
  SUBAGENT_PERSONAS.map(name => `subagent_${name} ×${persona.split(`subagent_${name}`).length - 1}`).join(', '))

process.stdout.write(`\ndoctor (${ROOT}): ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`}\n`)
if (failures.length > 0) process.exitCode = 1
