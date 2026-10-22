#!/usr/bin/env node
/**
 * make-preset.mjs — the ONLY writer of `cordis.patch.yml`.
 *
 * Source of truth is `text/persona.md` (and, from stage 3, `text/personas/*.md`).
 * Never hand-edit the generated patch: a hand edit is silently overwritten by the
 * next run, and `doctor.mjs` reports it as drift.
 *
 * Why the plugin list is derived rather than vendored. The bundle-patch format has
 * no inheritance and no deep merge, and a preset row's `config.plugins` is an
 * all-or-nothing field, so a preset that wants standard's tools must carry the
 * whole child list. Copying it by hand drifts the moment the shipped standard
 * changes. This script reads the shipped
 * `packages/bundle/web-app/presets/standard.patch.yml` from a dsh checkout, replaces the
 * persona `prefix:` line and the two shell `disabled:` gates, and proves each change was
 * confined to those lines by folding it back and comparing byte for byte. The source
 * file's SHA-256 and the dsh commit are recorded in the header so `doctor.mjs` can later
 * tell whether upstream moved.
 *
 * The transform is deliberately textual, not a YAML round-trip: the child list
 * carries `!!js` loader tags, and re-emitting them through a generic YAML
 * serializer is how expressions get mangled into inert strings.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  delegationRows as layerDelegationRows,
  topRows as layerTopRows,
} from './layers.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PERSONA_FILE = join(ROOT, 'text', 'persona.md')
export const PRESET_PATH = join(ROOT, 'cordis.patch.yml')
/** The tool names a live standard boot mounted, recorded by `verify-mount.mjs`. */
export const ROSTER_FILE = join(ROOT, 'scripts', 'roster.standard.json')
export const STANDARD_RELATIVE = 'packages/bundle/web-app/presets/standard.patch.yml'
/**
 * The installed 0.2.1 layout: the web bundle was renamed from `dsh-bundle-web-app` to
 * `dsh-web-app`, so the shipped standard lives at a shallower path than the checkout's.
 */
export const STANDARD_INSTALLED_RELATIVE = 'presets/standard.patch.yml'

/** Preset identity this bundle contributes; the child list stays standard's. */
export const PRESET = {
  rowId: 'preset-zcode',
  id: 'zcode',
  order: 6,
  name: 'ZCode 模式',
  description: '标准工具集之上的 ZCode 形状：身份与行为约束 persona、处境注入、具名子代理；不改动 Harness 源码。',
}

/**
 * Locate the shipped standard preset to derive from.
 *
 * Two layouts exist: a source checkout (`packages/bundle/web-app/presets/...`) and an
 * installed tree (`@deepseek-ai/dsh-web-app/presets/...`). `$DSH_STANDARD_FILE` names
 * the file outright, which is how the gates derive from the version the user actually
 * runs — a preset copied from an older checkout silently drops tools the installation
 * mounts (`schedule_*` arrived in 0.2.1 that way).
 * @returns the preset file and the directory quoted in the generated header.
 */
export function standardSource() {
  const explicit = process.env.DSH_STANDARD_FILE
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`DSH_STANDARD_FILE does not exist: ${explicit}`)
    return { repo: dirname(explicit), file: explicit }
  }
  const repo = process.env.DSH_REPO
    ?? resolve(ROOT, '..', 'deepseek-harness')
  const checkout = join(repo, STANDARD_RELATIVE)
  if (existsSync(checkout)) return { repo, file: checkout }
  const installed = join(repo, STANDARD_INSTALLED_RELATIVE)
  if (existsSync(installed)) return { repo, file: installed }
  throw new Error(
    `standard preset not found at ${checkout} or ${installed} — set DSH_REPO to a dsh checkout `
    + 'or DSH_STANDARD_FILE to the installed presets/standard.patch.yml',
  )
}

/** The `config.plugins` child-list text of the shipped standard row, verbatim. */
export function standardPlugins(source) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line === '        plugins:')
  if (start === -1) throw new Error('shipped standard row has no `plugins:` key at the expected indent')
  const body = lines.slice(start + 1)
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  if (body.length === 0) throw new Error('shipped standard `plugins:` block is empty')
  if (body.some(line => line.length > 0 && !line.startsWith('          '))) {
    throw new Error('shipped standard child list is not uniformly indented at 10 spaces')
  }
  return body.join('\n')
}

/**
 * The shell gates this mode demands. The shipped standard mounts `tool-bash` only off
 * win32 and `tool-pwsh` only on it; the user's local Git Bash setup reverses that for
 * `standard-gitbash` by flipping exactly these two conditions. The mode adopts the
 * flipped form as literals: `bash` on every platform, `pwsh` on none. Off win32 this
 * equals shipped standard's behavior; on win32 the bash executor comes from the
 * profile's Git Bash bundle (`dsh-git-bash` or equivalent), which INSTALL requires.
 */
export const SHELL_GATE = {
  'tool-bash': 'false',
  'tool-pwsh': 'true',
}

/**
 * Replace the two shell rows' `disabled:` lines with {@link SHELL_GATE}'s values.
 * @param plugins - the shipped child list.
 * @returns the patched list and the exact before/after lines, for the proof step.
 */
export function invertShellGating(plugins) {
  const substitutions = []
  let current = plugins
  for (const [id, value] of Object.entries(SHELL_GATE)) {
    const pattern = new RegExp(`^ {10}- id: ${id}\\n {12}name: [^\\n]*\\n {12}disabled: [^\\n]*$`, 'm')
    const original = current.match(pattern)?.[0]
    if (original === undefined) {
      throw new Error(`standard shell row \`${id}\` not found in its three-line form (id, name, disabled)`)
    }
    const patched = original.replace(/disabled: .*$/, `disabled: ${value}`)
    current = current.replace(original, patched)
    substitutions.push({ original, patched })
  }
  return { patched: current, substitutions }
}

/**
 * Drop the persona `suffix:` line that the shipped standard carries.
 *
 * DSH 0.2.1 removed the loop's built-in `cwd` prompt variable, so a `{{cwd}}`
 * reference fails prompt assembly before any model request. The current-directory
 * fact now arrives as a required runtime context from the working-directory service,
 * which makes the suffix redundant as well as fatal. The source preset on a 0.2.1
 * checkout no longer contains the line; this also covers deriving from an older one.
 * @param plugins - the shipped child list.
 * @returns the list without a persona `suffix` line, and the line that was removed.
 */
export function dropPersonaSuffix(plugins) {
  const line = plugins.match(/^(\s+)suffix: [^\n]*\{\{cwd\}\}[^\n]*$/m)?.[0]
  if (line === undefined) return { patched: plugins, removed: '' }
  return { patched: plugins.replace(`${line}\n`, ''), removed: line }
}

/**
 * Replace the persona `prefix:` line with a block scalar of the persona text.
 * @returns the patched child list and the block scalar that replaced the line.
 */
export function swapPersonaPrefix(plugins, persona) {
  const matches = plugins.match(/^(\s+)prefix: (.*)$/gm)
  if (matches === null || matches.length !== 1) {
    throw new Error(`expected exactly one persona prefix line, found ${matches?.length ?? 0}`)
  }
  const originalLine = matches[0]
  const indent = originalLine.slice(0, originalLine.indexOf('prefix:'))
  const body = persona.replace(/\s+$/, '').split('\n').map(line => `${indent}  ${line}`).join('\n')
  const block = `${indent}prefix: |-\n${body}`
  return { patched: plugins.replace(originalLine, block), originalLine, block }
}

/**
 * Insert rows inside the `delegation` group, after its last shipped child.
 * @returns the patched text and the exact inserted text (for the proof step).
 */
export function insertDelegationRows(plugins, rows) {
  if (rows.length === 0) return { patched: plugins, inserted: '' }
  const anchor = /^          - id: tool-ask-user$/m
  const at = plugins.search(anchor)
  if (at === -1) throw new Error('delegation insertion anchor `- id: tool-ask-user` not found')
  // Prove the anchor is inside the delegation group: the nearest preceding
  // indent-10 row must be it. Anything else means the shipped layout moved.
  const before = plugins.slice(0, at)
  const owners = before.match(/^ {10}- id: (\S+)$/gm)
  const owner = owners?.[owners.length - 1]?.match(/- id: (\S+)/)?.[1]
  if (owner !== 'delegation') {
    throw new Error(`delegation anchor resolves inside group "${owner ?? 'none'}", expected "delegation"`)
  }
  const inserted = rows.join('\n') + '\n'
  return { patched: `${plugins.slice(0, at)}${inserted}${plugins.slice(at)}`, inserted }
}

/** Append top-level rows (indent 10) after the restated standard child list. */
export function appendTopRows(plugins, rows) {
  if (rows.length === 0) return { patched: plugins, appended: '' }
  // The separating newline belongs to `appended` so the inverse operation in
  // `render` — dropping exactly `appended` from the tail — recovers the input.
  const appended = `\n${rows.join('\n')}\n`
  return { patched: `${plugins}${appended}`, appended }
}

/** One line of provenance for the generated header. */
function revisionOf(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Drop `tool-subagent` config keys DSH 0.2.1 removed.
 *
 * `backgroundMode` and `enableRunInBackground` are gone from the schema. Schemastery
 * keeps undeclared keys (`merge(result, data)`), so a leftover value reaches `apply()`
 * as dead configuration rather than a startup error — which is worse for a preset
 * because it silently promises behaviour the runtime no longer has. A 0.2.1 source
 * preset no longer carries them; this also covers deriving from an older checkout.
 * @param plugins - the shipped child list.
 * @returns the list without the retired keys, and the lines that were removed.
 */
export function dropRetiredSubagentKeys(plugins) {
  const removed = []
  const patched = plugins.replace(/^ {18}(backgroundMode|enableRunInBackground): [^\n]*\n/gm, (line) => {
    removed.push(line.trimEnd())
    return ''
  })
  return { patched, removed }
}

/**
 * Render the whole bundle patch.
 * @param parts - the shipped child list, the persona text, the extra row groups,
 *   the upstream source text and its checkout.
 * @returns the patch file content.
 * @throws when a change reaches bytes outside what this bundle is allowed to touch.
 */
export function render({ plugins, persona, delegationRows = [], topRows = [], sourceText, sourceFile, repo }) {
  const { patched: withoutSuffix, removed: suffixLine } = dropPersonaSuffix(plugins)
  const { patched: source } = dropRetiredSubagentKeys(withoutSuffix)
  const { patched: swapped, block } = swapPersonaPrefix(source, persona)
  if (swapped.replace(block, source.match(/^(\s+)prefix: (.*)$/m)[0]) !== source) {
    throw new Error('persona substitution touched bytes outside the prefix line')
  }
  const { patched: withShell, substitutions } = invertShellGating(swapped)
  let folded = withShell
  for (const { original, patched } of substitutions) folded = folded.replace(patched, original)
  if (folded !== swapped) {
    throw new Error('shell gate substitution touched bytes outside the disabled lines')
  }
  const { patched: withDelegation, inserted } = insertDelegationRows(withShell, delegationRows)
  if (inserted.length > 0 && withDelegation.replace(inserted, '') !== withShell) {
    throw new Error('delegation insertion touched bytes outside the inserted rows')
  }
  const { patched, appended } = appendTopRows(withDelegation, topRows)
  if (appended.length > 0 && patched.slice(0, patched.length - appended.length) !== withDelegation) {
    throw new Error('top-level append touched bytes outside the appended rows')
  }
  const countJs = text => (text.match(/!!js/g) || []).length
  const removedJs = substitutions.reduce((sum, s) => sum + countJs(s.original) - countJs(s.patched), 0)
  const expectedTags = countJs(source) - removedJs + countJs(delegationRows.join('\n')) + countJs(topRows.join('\n'))
  if (countJs(withDelegation) !== expectedTags) {
    throw new Error(`loader tag count changed: expected ${expectedTags} (standard's ${countJs(source)} plus this bundle's rows), found ${countJs(withDelegation)}`)
  }
  const ids = (text, indent) => [...text.matchAll(new RegExp(`^ {${indent}}- id: (\\S+)$`, 'gm'))].map(m => m[1])
  if (ids(withDelegation, 10).join(',') !== ids(source, 10).join(',')) {
    throw new Error('top-level child row ids changed; only the persona text and appended rows may differ')
  }
  const sha = createHash('sha256').update(sourceText).digest('hex')
  const personaChars = persona.replace(/\s+$/, '').length
  return [
    '# GENERATED — do not hand-edit. The only writer is `npm run preset`',
    `#   persona text : text/persona.md (${personaChars} chars)`,
    `#   derived from : ${basename(sourceFile)} @ ${repo} (r${revisionOf(repo)})`,
    `#   source sha256: ${sha}`,
    '#',
    '# The child list is standard\'s list with these changes: the persona',
    '# `prefix:` line carries the persona text, the two shell `disabled:` gates are',
    '# inverted (bash mounted on every platform, pwsh on none — see SHELL_GATE), the',
    '# named subagent rows are inserted inside',
    '# the delegation group, and this bundle\'s own plugin rows are appended at the end.',
    '# The bundle-patch format offers no inheritance and no deep merge, so the whole list',
    '# must be restated here.',
    '#',
    '# Each named subagent is a plain tool-subagent row with no `agentPreset`: DSH 0.2.1',
    '# removed `persona`/`toolFilter` and a child preset REPLACES the parent inheritance',
    '# rather than extending it, so a delegating child joins the parent preset and gets',
    '# its full tool set, its persona, and the `send_message` return channel.',
    '- insert:',
    `    - id: ${PRESET.rowId}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${PRESET.id}`,
    `        order: ${PRESET.order}`,
    `        name: '${PRESET.name}'`,
    `        description: '${PRESET.description}'`,
    '        plugins:',
    patched,
    '',
  ].join('\n')
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)
if (isMain) {
  const persona = readFileSync(PERSONA_FILE, 'utf8')
  if (persona.trim().length === 0) throw new Error('text/persona.md is empty')
  const { repo, file } = standardSource()
  const sourceText = readFileSync(file, 'utf8')
  const args = {
    plugins: standardPlugins(sourceText),
    persona,
    delegationRows: layerDelegationRows(),
    topRows: layerTopRows(),
    sourceText,
    sourceFile: file,
    repo,
  }
  const out = render(args)
  writeFileSync(PRESET_PATH, out)
  if (render(args) !== out) process.stdout.write('WARNING: generator is not byte-idempotent\n')
  process.stdout.write(`wrote cordis.patch.yml (${out.length} chars) from ${file}\n`)
}
