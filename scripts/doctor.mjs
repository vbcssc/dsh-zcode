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
  PERSONA_FILE, PRESET_PATH, ROOT, render, standardPlugins, standardSource,
} from './make-preset.mjs'
import {
  delegationRows as layerDelegationRows, topRows as layerTopRows, SUBAGENT_PERSONAS,
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
const fresh = render({
  plugins,
  persona,
  delegationRows: rows,
  topRows: layerTopRows(),
  sourceText,
  sourceFile: file,
  repo,
})
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
// persona is a whole-request failure, not a cosmetic one. DSH 0.2.1 dropped the
// loop's built-in `cwd` variable, so only `model` is left.
const used = [...new Set([...persona.matchAll(/\{\{([^{}]*)\}\}/g)].map(m => m[1]))]
check('persona references only prompt variables the harness supplies',
  used.every(name => name === 'model'),
  used.length === 0 ? 'no variables' : used.join(', '))

// ── named subagents ───────────────────────────────────────────────────────────────
// DSH 0.2.1 rejects `persona` and `toolFilter` on tool-subagent, so the persona and the
// child's tool rows live in a dedicated preset the delegation row names. These checks
// assert that pairing survived generation.
const delegations = [...committed.matchAll(
  /^ {14}- id: (tool-subagent-\S+)\n {16}name: '@deepseek-ai\/dsh-tool-subagent'\n {16}config:\n((?: {18}[^\n]*\n?)+)/gm,
)].map(([, id, body]) => ({ id, body }))
check('no tool-subagent row carries a config the 0.2.1 schema rejects',
  delegations.every(({ body }) => !/persona:|toolFilter:|backgroundMode:|enableRunInBackground:/.test(body)),
  delegations.filter(({ body }) => /persona:|toolFilter:|backgroundMode:|enableRunInBackground:/.test(body))
    .map(({ id }) => id).join(', ') || `${delegations.length} rows checked`)

// A named subagent is now a plain delegation row: no `agentPreset`, so the child joins
// the parent's preset through `composeFrom` and inherits its whole tool set — including
// the `send_message` return channel the harness's own return guidance names. A row that
// started selecting a child preset again would REPLACE that inheritance, which is the
// defect this check exists to keep out.
check('no delegation row selects a child preset (children inherit the parent)',
  delegations.every(({ body }) => !/^ {18}agentPreset: /m.test(body)),
  delegations.filter(({ body }) => /^ {18}agentPreset: /m.test(body)).map(({ id }) => id).join(', ')
    || `${delegations.length} rows inherit`)
check('the bundle declares no child preset rows of its own',
  !/^ {4}- id: preset-(?!zcode$).+$/m.test(committed),
  [...committed.matchAll(/^ {4}- id: preset-(\S+)$/gm)].map(([, id]) => id).join(', ') || 'none')

const toolNames = [...committed.matchAll(/^ {18}toolName: (\S+)$/gm)].map(m => m[1])
const ours = SUBAGENT_PERSONAS.map(name => `subagent_${name}`)
check('each named subagent reaches the model under its own tool name, used once',
  ours.every(name => toolNames.includes(name))
    && ours.every(name => toolNames.filter(entry => entry === name).length === 1),
  `bundle rows ${ours.join(', ')} among ${toolNames.length} toolName entries`)

// The patch inverts the shipped shell gates: `tool-bash` is enabled on every platform
// and `tool-pwsh` on none. A regression back to the shipped `!!js` conditions would put
// the mode on PowerShell on Windows, which is exactly what the inversion exists to
// prevent, so the two gates are asserted by name as well as by the byte-equality check.
const gateOf = id => committed.match(
  new RegExp(`^ {10}- id: ${id}\\n {12}name: [^\\n]*\\n {12}disabled: (\\S+)`, 'm'))?.[1]
check('the preset inverts the shipped shell gates (bash enabled everywhere, pwsh nowhere)',
  gateOf('tool-bash') === 'false' && gateOf('tool-pwsh') === 'true',
  `tool-bash: ${gateOf('tool-bash') ?? 'row not found'}, tool-pwsh: ${gateOf('tool-pwsh') ?? 'row not found'}`)
// A named subagent's tool description is the shipped generic wording — identical for
// every row (measured by `verify-mount.mjs`) — so the persona is the only surface where
// the model learns what each named subagent is for. Both names must appear, and every
// mention must sit inside the `# Delegation` section: a name dropped elsewhere (a tool
// inventory, an example) would teach the model the wrong thing about why it exists.
const delegationSection = persona.match(/^# Delegation$([\s\S]*?)(?=^# |(?![\s\S]))/m)?.[1] ?? ''
check('persona names each named subagent, and only inside the Delegation section',
  SUBAGENT_PERSONAS.every(name => delegationSection.includes(`subagent_${name}`))
    && SUBAGENT_PERSONAS.every(name => persona.split(`subagent_${name}`).length - 1
      === delegationSection.split(`subagent_${name}`).length - 1),
  SUBAGENT_PERSONAS.map((name) => {
    const total = persona.split(`subagent_${name}`).length - 1
    const inside = delegationSection.split(`subagent_${name}`).length - 1
    return `subagent_${name} ×${total} (${inside} in Delegation)`
  }).join(', '))

// Children inherit the parent's whole tool set (no `agentPreset`), so the delegation
// brief is the ONLY place a constraint on a child can live. That makes two statements
// load-bearing and easy to lose in an edit: that the inheritance exists, and that the
// brief must carry the constraints. Both are asserted on the persona text because a
// persona that quietly stopped saying either would leave the model delegating without
// them — the child would then write files a research task must not touch.
check('persona states that children inherit the full tool set',
  /inherit(?:s)? (?:your )?(?:complete|full) tool set/i.test(persona),
  (persona.match(/[^.]*inherit[^.]*\./i)?.[0] ?? 'no inheritance statement').trim().slice(0, 120))
check('persona tells the model to put constraints in the delegation brief',
  /constraints/i.test(persona) && /brief/i.test(persona),
  `mentions brief: ${/brief/i.test(persona)}, constraints: ${/constraints/i.test(persona)}`)

// The explore brief must name the read-only constraint explicitly; the child has
// `write`/`edit` mounted and will use them if the brief does not forbid it. Matched
// within ONE sentence of the tool name: a looser window reaches the general
// constraints paragraph far below and would pass even after the pairing was deleted.
const exploreReadOnlyPairing = persona.match(/`subagent_explore`[^.]*\./)?.[0] ?? ''
check('persona pairs subagent_explore with its read-only brief constraint',
  /read-only/i.test(exploreReadOnlyPairing),
  exploreReadOnlyPairing === '' ? 'tool name absent' : exploreReadOnlyPairing.trim().slice(0, 140))

// Children inherit this persona, so one text addresses both roles. Two failures matter
// for a long delegation: a parent that never tells a running child its premise changed,
// and a child that saves every finding for the final report. Each half is anchored to
// the paragraph that carries the rule, so deleting either direction turns this red.
const syncParagraph = persona.match(/Delegation is a two-way channel[^]*?(?=\n\n)/)?.[0] ?? ''
check('persona tells the parent to push a changed premise to a running child immediately',
  /two-way channel/.test(syncParagraph)
    && /`send_message` immediately/.test(syncParagraph)
    && /stale/.test(syncParagraph),
  syncParagraph === '' ? 'two-way paragraph absent' : syncParagraph.trim().slice(0, 140))
check('persona tells the delegated child to report mid-task, not only in the final summary',
  /delegated child: message your parent/.test(syncParagraph)
    && /final summary/.test(syncParagraph)
    && /reporting cadence/i.test(persona),
  syncParagraph === '' ? 'two-way paragraph absent' : syncParagraph.trim().slice(-140))

process.stdout.write(`\ndoctor (${ROOT}): ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`}\n`)
if (failures.length > 0) process.exitCode = 1
