/**
 * layers.mjs — the rows this bundle adds to the restated standard child list.
 *
 * Kept separate from `make-preset.mjs` so the declarative surface (which rows, at
 * which indent, naming which package) is reviewable on its own, and so `doctor.mjs`
 * can recompute the patch from the same data the generator used.
 *
 * Indentation is load-bearing: `config.plugins` children sit at 10 spaces, rows inside
 * a `cordis:group`'s `config` at 14, and their keys at 16. A block scalar under a
 * 16-space key puts its body at 18.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This bundle's root directory, computed locally to keep the import graph acyclic. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The situational plugin row: one top-level child pointing at this package's
 * `./situation` subpath export. The bundle-patch format resolves a plugin `name`
 * through the profile's package resolution, so the row must name the installed
 * package path, not a file on disk.
 * @returns the appended indent-10 rows.
 */
export function topRows() {
  return [
    '          - id: zcode-situation',
    "            name: 'dsh-zcode-mode/situation'",
  ]
}

/**
 * Read a named subagent's persona source.
 * @param name - the subagent's short name, matching `text/personas/<name>.md`.
 * @returns the persona text with trailing whitespace removed.
 * @throws when the source file is missing or empty — a subagent row without its
 *   persona would mount a child that inherits nothing and says nothing.
 */
export function personaSource(name) {
  const file = join(ROOT, 'text', 'personas', `${name}.md`)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`subagent persona source is missing: ${file}`)
  }
  if (text.trim().length === 0) throw new Error(`subagent persona source is empty: ${file}`)
  return text.replace(/\s+$/, '')
}

/**
 * Render a persona as a YAML block-scalar key plus its body lines.
 *
 * Block scalar with strip chomping (`|-`) so no trailing newline survives the parse,
 * and blank source lines stay truly empty — a line of spaces would not round-trip.
 * @param text - the persona body.
 * @returns the `persona:` key line and the indented body lines.
 */
function personaLines(text) {
  return ['                  persona: |-', ...text.split('\n').map(line => `                    ${line}`)]
}

/**
 * The named subagent rows ZCode has and dsh's shipped preset does not.
 *
 * Both sit inside the `delegation` group at indent 14. `provider: spawn` is the local
 * child-process driver the shipped `tool-subagent` row already uses. `maxDepth: 1` is
 * what makes "you cannot delegate further" a fact rather than advice.
 *
 * The filter names `bash` statically: this bundle's patch inverts the shipped
 * standard's shell gates (`SHELL_GATE` in `make-preset.mjs`), so `tool-bash` is mounted
 * on every platform and `tool-pwsh` on none. On win32 the bash executor is the
 * profile's Git Bash bundle (`dsh-git-bash` or equivalent) — INSTALL requires it, and a
 * profile without it mounts the tool but cannot run it. Every other name here is
 * checked against the live recorded roster (see `roster.standard.json`).
 *
 * The general-purpose row declares NO `toolFilter`: an absent filter leaves the child
 * with the parent's full tool set, which is the faithful translation of ZCode's
 * `tools: ["*"]` and is strictly smaller than restating names that drift per release.
 * @returns the indent-14 rows, with persona bodies read from `text/personas/`.
 */
export function delegationRows() {
  const rows = [
    '              - id: tool-subagent-zcode-explore',
    "                name: '@deepseek-ai/dsh-tool-subagent'",
    '                config:',
    '                  provider: spawn',
    '                  toolName: subagent_explore',
    '                  backgroundMode: continuable',
    '                  maxDepth: 1',
    '                  toolFilter:',
    '                    allow:',
    '                      - bash',
    '                      - glob',
    '                      - grep',
    '                      - read',
    '                      - web_fetch',
    '                      - web_search',
    ...personaLines(personaSource('explore')),
    '              - id: tool-subagent-zcode-general',
    "                name: '@deepseek-ai/dsh-tool-subagent'",
    '                config:',
    '                  provider: spawn',
    '                  toolName: subagent_general',
    '                  backgroundMode: continuable',
    '                  maxDepth: 1',
    ...personaLines(personaSource('general')),
  ]
  return rows
}

/** The short names of the personas this bundle mounts, for existence checks. */
export const SUBAGENT_PERSONAS = ['explore', 'general']
