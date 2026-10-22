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
 *
 * The named subagents are plain `@deepseek-ai/dsh-tool-subagent` rows. DSH 0.2.1
 * removed `persona`, `toolFilter`, and `backgroundMode` from that package's config
 * (verified against the installed 0.2.1 `Config`: only `provider`, `toolName`,
 * `modelSelectionSettings`, `agentOptions`, `agentPreset`, `allowedAgentPresets`, and
 * `maxDepth` remain). A row with no `agentPreset` joins the PARENT's preset through
 * `applyChildComposition`'s `composeFrom` path, so the child inherits the parent's whole
 * tool set and persona. That is the original dsh behaviour and the reason these rows
 * carry no separate preset: a child preset would replace the inheritance, not extend
 * it, and every tool it needs would have to be restated (which is how an earlier
 * revision silently dropped the child's `send_message` return channel).
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
 *
 * The verification-guard row follows it. It is a native plugin rather than a
 * Claude Code hook bridge on purpose: the bridges execute `command` hooks read
 * from an external `hooks.json`, so a bundle cannot ship its own check through
 * them, and their `continue:false` halts have no run-level effect. A native row
 * subscribes to `agent/turn-stopping` directly and steers, which is the one
 * mechanism the harness documents as forcing another step.
 *
 * The evidence-plan row is the item-level counterpart to that guard. The guard
 * asks one question at the turn boundary: did a file-changing turn run any
 * successful command? This row adds `plan_write`, which asks a sharper one per
 * plan item: did this turn run the specific command that item named as its
 * proof? The two are complementary rather than redundant — the guard catches a
 * turn that verified nothing, the plan catches an item declared done on the
 * strength of some other command. It is mounted through the package's own
 * `presets` config default (`['zcode']`), so the row is profile-wide but the
 * tool only reaches sessions whose durable header reports this preset.
 * @returns the appended indent-10 rows.
 */
export function topRows() {
  return [
    '          - id: zcode-situation',
    "            name: 'dsh-zcode-mode/situation'",
    '          - id: zcode-verification-guard',
    "            name: 'dsh-zcode-mode/verification-guard'",
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
 * Render a persona as a `prefix:` block scalar plus its body lines.
 *
 * `@deepseek-ai/dsh-persona` names its required field `prefix`; it is rendered as the
 * `deployment:persona-prefix` section. Block scalar with strip chomping (`|-`) so no
 * trailing newline survives the parse, and blank source lines stay truly empty — a
 * line of spaces would not round-trip.
 * @param text - the persona body.
 * @param indent - column of the `prefix:` key.
 * @returns the `prefix:` key line and the indented body lines.
 */
function personaLines(text, indent) {
  const pad = ' '.repeat(indent)
  const bodyPad = ' '.repeat(indent + 2)
  return [`${pad}prefix: |-`, ...text.split('\n').map(line => (line.length > 0 ? `${bodyPad}${line}` : ''))]
}

/**
 * The named subagents this bundle adds, as plain `tool-subagent` rows.
 *
 * Each row names the tool the parent sees (`subagent_<name>`) and caps depth at 1, so
 * the child cannot delegate further. Nothing else is declared: the child inherits the
 * parent's preset — tools, persona, and the `send_message` return channel — exactly as
 * a shipped `subagent` row does. `provider: spawn` is the in-process driver the shipped
 * row already uses.
 * @returns the indent-14 rows.
 */
export function delegationRows() {
  const rows = []
  for (const name of SUBAGENT_PERSONAS) {
    rows.push(
      `              - id: tool-subagent-zcode-${name}`,
      "                name: '@deepseek-ai/dsh-tool-subagent'",
      '                config:',
      '                  provider: spawn',
      `                  toolName: subagent_${name}`,
      '                  maxDepth: 1',
    )
  }
  return rows
}

/** The short names of the named subagents this bundle mounts. */
export const SUBAGENT_PERSONAS = ['explore', 'general']
