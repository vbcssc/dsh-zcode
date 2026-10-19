#!/usr/bin/env node
/**
 * verify-mount.mjs — does a real dsh boot ACCEPT this bundle and ACTIVATE the preset?
 *
 * `dsh --dump-config` only proves composition: the row lands in the entry list. A
 * preset can compose and still fail to activate, and the registry reports that as a
 * `broken` roster row — or, worse, as a throw out of `acquireScope` that no roster row
 * ever shows. And unlike a persona-only bundle, this one's patch names a plugin
 * subpath (`dsh-zcode-mode/situation`), which only resolves if the package is really
 * laid into the profile's package tree. So this script installs that layout into a
 * detached copy of the shared profile and boots the result.
 *
 * Order matters for one reason: a `file:` install hard links the bundle into the
 * profile, and the CLI writes the profile's own `cordis.patch.yml` during install.
 * Doing that against the shared home would write THROUGH the hard links into the
 * sibling repository's working tree. Hence `detachProfile` FIRST (fresh inodes),
 * install SECOND.
 *
 * What it proves:
 *   1. the bundle installs, `zcode` appears in the live roster, and it activates
 *      without diagnostics or an acquisition throw;
 *   2. the plugin row resolves — the scope carries this bundle's contexts;
 *   3. the tool set is standard's plus exactly this bundle's named subagents, and the
 *      live roster matches the recorded one the generator validated filters against;
 *   4. the assembled persona equals `text/persona.md` byte for byte, the shipped
 *      `standard` arm is untouched, and the whole-prompt delta equals the persona delta
 *      plus one harness-generated guidance section per named subagent;
 *   5. a named subagent's parent-facing description is the shipped generic wording, which
 *      is what forces this bundle to state each subagent's purpose in the persona instead;
 *   6. with no session attached, the repository provider contributes nothing rather than
 *      throwing (its content against a real working directory is `unit-situation.mjs`);
 *   7. declared peer versions are satisfied by the installation — a mismatch silently
 *      drops the WHOLE bundle into `skippedBundles`, so the preset disappears with one
 *      stderr line and no error.
 *
 * Set `ZCODE_RECORD_ROSTER=1` to write `scripts/roster.standard.json` (the live
 * standard tool names) after the checks pass; that file is what `layers.mjs` validates
 * subagent tool filters against without a boot.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  T3_HOME, assertDetached, bootProfile, copyTree, detachProfile, discoverInstallAnchor,
  ensureInstalledProfile, presetAssembly, presetList, presetPersona, presetToolNames,
} from '../../starfield-dsh/tests/lib/real-channel.mjs'

import { personaSource } from './layers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, 'scripts', '.verify-home')
const PERSONA_ROW = 'deployment:persona-prefix'
const OUR_CONTEXTS = ['zcode:environment', 'zcode:repository', 'zcode:current-date']
const ROSTER_FILE = join(ROOT, 'scripts', 'roster.standard.json')

/** The named subagents this bundle adds. */
const SUBAGENT_TOOLS = ['subagent_explore', 'subagent_general']

const failures = []
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  process.stdout.write(line + '\n')
  if (!ok) failures.push(line)
}

/**
 * Lay this package into a profile's `node_modules` the way an install would, without
 * running an install.
 * @param dir - the detached profile directory.
 * @returns the installed package directory.
 */
function installInto(dir) {
  const target = join(dir, 'node_modules', 'dsh-zcode-mode')
  rmSync(target, { recursive: true, force: true })
  // `node_modules` is excluded on purpose: here it is a junction to the global dsh
  // store (a development convenience for resolving peers), and recursing into it
  // would copy the whole installation.
  for (const entry of ['package.json', 'src', 'text', 'cordis.patch.yml']) {
    copyTree(join(ROOT, entry), join(target, entry))
  }
  return target
}

const anchor = discoverInstallAnchor()
ensureInstalledProfile(T3_HOME)

// ── 1 · detach, then lay the bundle into the copy ───────────────────────────────
rmSync(SCRATCH, { recursive: true, force: true })
const home = join(SCRATCH, 'h')
const dir = detachProfile(T3_HOME, home)
assertDetached(join(dir, 'cordis.patch.yml'), join(T3_HOME, 'profiles', 'web', 'cordis.patch.yml'))

const target = installInto(dir)
const profilePatch = join(dir, 'cordis.patch.yml')
const bundle = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const existing = readFileSync(profilePatch, 'utf8').replace(/^\[\]\s*$/m, '').trim()
writeFileSync(profilePatch, existing.length === 0 ? bundle : `${existing}\n${bundle}`)
check('the bundle is laid into the detached profile as an installed package',
  existsSync(join(target, 'src', 'situation.js')), join(target, 'src', 'situation.js'))
// Deliberately NOT `dsh plugin add`: a copied profile carries the source home's pnpm
// virtual-store record, so an install there fails with
// ERR_PNPM_UNEXPECTED_VIRTUAL_STORE, and installing into the shared home instead would
// write through hard links into the sibling repository's fixture. The composition being
// booted is the same either way: the package resolves from the profile's node_modules
// and its patch reaches the profile layer.

const { ctx } = await bootProfile({ dir, home, anchor })
let roster
/** Read one preset's registered context contributions, by name and length. */
const readContexts = async id => {
  const presets = ctx.get('agentPresets')
  const scope = await presets.acquireScope(id)
  try {
    const assembly = await ctx.get('systemPrompt').assemble({ scope: scope.key })
    return assembly.contexts.map(context => ({ name: context.name, chars: context.text.length, text: context.text }))
  } finally {
    await scope[Symbol.asyncDispose]?.()
  }
}
/** The `subagent_*` schemas one preset exposes, with their model-visible descriptions. */
const readSubagents = async id => {
  const presets = ctx.get('agentPresets')
  const scope = await presets.acquireScope(id)
  try {
    return ctx.get('tools').schemas(scope.key)
      .filter(schema => schema.name.startsWith('subagent_'))
      .map(schema => ({ name: schema.name, chars: schema.description.length, description: schema.description }))
  } finally {
    await scope[Symbol.asyncDispose]?.()
  }
}
const readArm = async (id) => {
  /** Each read is captured separately: one provider refusing a bare scope must not erase
   *  what the others reported, or the diagnosis points at the wrong row. */
  const field = async (name, run) => {
    try {
      return await run()
    } catch (error) {
      const reason = `${error.code ?? 'error'}: ${error.details?.reason ?? error.message}`
      failures.push(`${name} read failed for ${id} — ${reason}`)
      process.stdout.write(`FAIL read ${name} for ${id} — ${reason}\n`)
      return undefined
    }
  }
  const row = { id }
  row.tools = (await field('tools', () => presetToolNames(ctx, id))) ?? []
  row.assembly = await field('assembly', () => presetAssembly(ctx, id))
  row.persona = await field('persona', () => presetPersona(ctx, id))
  row.contexts = (await field('contexts', () => readContexts(id))) ?? []
  row.subagents = (await field('subagents', () => readSubagents(id))) ?? []
  // A failed child activation does not leave a readable `broken` roster row: `acquireScope`
  // throws `agent-preset/invalid` instead, so acquisition is reported by the read above.
  row.broken = roster.find(entry => entry.id === id)?.broken
  return row
}
let standard, zcode
try {
  roster = await presetList(ctx)
  standard = await readArm('standard')
  zcode = await readArm('zcode')
} finally {
  await ctx.fiber.dispose()
}

// ── 2 · activation ─────────────────────────────────────────────────────────────
const row = roster.find(entry => entry.id === 'zcode')
check('zcode preset is present in the live roster', row !== undefined,
  `roster: ${roster.map(entry => entry.id).join(', ')}`)
// A successful tool read IS the acquisition proof: `acquireScope` throws for a preset whose
// rows failed to mount, and that throw is reported as its own FAIL line by `readArm`.
check('zcode activates (no roster diagnostics, scope acquires)',
  row?.broken === undefined && (zcode.tools ?? []).length > 0,
  row?.broken !== undefined ? JSON.stringify(row.broken) : `${(zcode.tools ?? []).length} tools read`)

// ── 3 · the plugin row resolved and registered its contexts ────────────────────
const names = zcode.contexts.map(context => context.name)
check('the situational plugin mounted inside the zcode scope',
  OUR_CONTEXTS.every(name => names.includes(name)),
  `contexts: ${names.join(', ') || 'none'}`)
const envBlock = zcode.contexts.find(context => context.name === 'zcode:environment')
check('the environment block renders in a bare scope (no session, no cwd)',
  envBlock !== undefined && envBlock.chars > 0 && envBlock.text.includes('Platform:'),
  envBlock?.text.split('\n')[1] ?? 'absent')
check('the environment block tells the model the mounted terminal is bash',
  envBlock?.text.includes('Terminal tool: bash') ?? false,
  envBlock?.text.split('\n').find(line => line.startsWith('Terminal tool')) ?? 'absent')
const stdNames = standard.contexts.map(context => context.name)
check('standard carries none of this bundle\'s contexts',
  OUR_CONTEXTS.every(name => !stdNames.includes(name)),
  `standard contexts: ${stdNames.join(', ') || 'none'}`)

// ── 4 · the restated child list mounts identically ─────────────────────────────────
const added = (zcode.tools ?? []).filter(n => !(standard.tools ?? []).includes(n))
const removed = (standard.tools ?? []).filter(n => !(zcode.tools ?? []).includes(n))
// Off win32 the shipped standard already mounts bash and not pwsh, so the inversion is
// invisible in the diff; on win32 it is the swap itself: bash in, pwsh out.
const isWin32 = process.platform === 'win32'
const expectedAdded = ['subagent_explore', 'subagent_general', ...(isWin32 ? ['bash'] : [])]
const expectedRemoved = isWin32 ? ['pwsh'] : []
check('tool set is standard\'s plus the named subagents, with the shell gates inverted',
  added.slice().sort().join(',') === expectedAdded.slice().sort().join(',')
    && removed.slice().sort().join(',') === expectedRemoved.slice().sort().join(','),
  `+${added.join(',') || 'none'} / -${removed.join(',') || 'none'} over ${standard.tools.length} tools`)
check('the mode mounts bash and mounts no pwsh on any platform',
  (zcode.tools ?? []).includes('bash') && !(zcode.tools ?? []).includes('pwsh'),
  `shell tools: ${(zcode.tools ?? []).filter(name => name === 'bash' || name === 'pwsh').join(', ') || 'none'}`)

// ── 5 · the persona text is what reaches the model ────────────────────────────────
const expected = readFileSync(join(ROOT, 'text', 'persona.md'), 'utf8').replace(/\s+$/, '')
check('assembled persona equals text/persona.md byte for byte',
  zcode.persona?.persona === expected,
  `${zcode.persona?.persona?.length ?? 'absent'} vs ${expected.length} chars`)

const section = zcode.assembly?.sections.find(s => s.name === PERSONA_ROW)
const stdSection = standard.assembly?.sections.find(s => s.name === PERSONA_ROW)
check('standard arm is untouched (still the shipped one-liner)',
  stdSection?.chars === 54, `standard persona ${stdSection?.chars} chars`)

const delta = (zcode.assembly?.text.length ?? 0) - (standard.assembly?.text.length ?? 0)
// What the bundle puts into the PARENT prompt is the persona plus, per named
// subagent, one generated `tool:subagent_*` guidance section (measured: 121 characters
// each). The subagent personas themselves go to the CHILD's persona section at spawn, not
// here — a row mis-indented out of the delegation group would show up in this equality.
// The shell inversion swaps the shipped guidance section for the other shell's
// (`tool:pwsh` out, `tool:bash` in on win32), so the diff is checked section by section:
// unrelated drift may not hide inside the totals on either side of an equality.
const personaDelta = (section?.chars ?? 0) - (stdSection?.chars ?? 0)
const stdByName = new Map((standard.assembly?.sections ?? []).map(s => [s.name, s.chars]))
const zcodeByName = new Map((zcode.assembly?.sections ?? []).map(s => [s.name, s.chars]))
const secAdded = [...zcodeByName.entries()].filter(([name]) => !stdByName.has(name))
const secRemoved = [...stdByName.keys()].filter(name => !zcodeByName.has(name))
const secChanged = [...zcodeByName.entries()].filter(([name, chars]) => stdByName.has(name) && stdByName.get(name) !== chars)
const wantedAdded = ['tool:subagent_explore', 'tool:subagent_general', ...(isWin32 ? ['tool:bash'] : [])].sort().join(',')
const wantedRemoved = isWin32 ? 'tool:pwsh' : ''
check('the section diff is exactly: the subagent guidance rows appear and the shell guidance swaps',
  secAdded.map(([name]) => name).sort().join(',') === wantedAdded
    && secRemoved.sort().join(',') === wantedRemoved
    && secChanged.map(([name]) => name).sort().join(',') === PERSONA_ROW,
  `added[${secAdded.map(([n, c]) => `${n}:${c}`).join(', ') || 'none'}] removed[${secRemoved.join(', ') || 'none'}] changed[${secChanged.map(([n]) => n).join(', ') || 'none'}]`)
check('whole-prompt delta equals the persona delta plus the added sections minus the removed ones',
  zcode.assembly !== undefined
    && delta === personaDelta + secAdded.reduce((sum, [, chars]) => sum + chars, 0)
      - secRemoved.reduce((sum, name) => sum + (stdByName.get(name) ?? 0), 0),
  `prompt ${standard.assembly?.text.length} -> ${zcode.assembly?.text.length} (+${delta} = persona +${personaDelta} + ${secAdded.map(([n, c]) => `${n}:${c}`).join(', ') || 'none'} - ${secRemoved.map(name => `${name}:${stdByName.get(name)}`).join(', ') || 'none'})`)

// ── 4b · how the named subagents surface to the parent model ────────────────────────
check('both named subagents are mounted in the zcode scope',
  SUBAGENT_TOOLS.every(tool => (zcode.tools ?? []).includes(tool)),
  `subagent tools present: ${(zcode.tools ?? []).filter(name => name.startsWith('subagent_')).join(', ')}`)
// Differential proof of where a row's `persona` goes: the two named subagents share ONE
// parent-facing description — the shipped generic wording — so neither persona is in it
// (a persona reaches the child scope at spawn). That is why this bundle's persona carries
// a `# Delegation` section naming both tools, which `doctor.mjs` checks.
const namedDescriptions = (zcode.subagents ?? []).filter(entry => SUBAGENT_TOOLS.includes(entry.name))
check('the two named subagents share one identical parent-facing description, so neither persona reached it',
  namedDescriptions.length === 2
    && namedDescriptions[0].description === namedDescriptions[1].description
    && !namedDescriptions[0].description.includes(personaSource('explore').slice(0, 60)),
  namedDescriptions.map(entry => `${entry.name}:${entry.chars}`).join(', ') || 'no named tools found')
const contextChars = zcode.contexts.reduce((sum, context) => sum + context.chars, 0)
process.stdout.write(`NOTE situational contexts in a bare scope: ${contextChars} chars\n`)

// ── 5 · the sessionless guard ──────────────────────────────────────────────────────
// The repository provider reads `context.agent?.session?.header?.cwd`, which a bare
// assembly has no agent to supply. Passing a hand-made agent object is NOT a faithful
// substitute — the shipped sandbox and approval providers read other Agent fields and
// throw on a stub — so the working-directory path is proven by `unit-situation.mjs`, which
// runs the same `repositoryBlock` against a real checkout. What is provable here is that
// the absence is handled by yielding nothing rather than by throwing.
const repositoryEntry = zcode.contexts.find(entry => entry.name === 'zcode:repository')
check('with no session attached, the repository context contributes nothing (and does not throw)',
  repositoryEntry !== undefined && repositoryEntry.chars === 0,
  repositoryEntry === undefined ? 'context absent' : `${repositoryEntry.chars} chars`)

/**
 * Whether an installed version satisfies a declared peer range.
 *
 * Only the two forms this bundle uses are accepted, and an unrecognised form fails
 * rather than passing: the point of the check is that a mismatch silently drops the
 * whole bundle, so a checker that waves through a range it cannot read defeats it.
 * @param declared - the peer range from `package.json`.
 * @param actual - the version the installation carries.
 * @returns whether the installed version satisfies the declaration.
 */
function satisfies(declared, actual) {
  if (/^[\d.]+(?:-[0-9A-Za-z.]+)?$/.test(declared)) return declared === actual
  const tilde = declared.match(/^~(\d+)\.(\d+)\.(\d+)$/)
  if (tilde === null) return false
  const [major, minor, patch] = actual.split('-')[0].split('.')
  return Number(tilde[1]) === Number(major) && Number(tilde[2]) === Number(minor)
    && Number(tilde[3]) <= Number(patch)
}

// ── 6 · peer parity: a mismatch silently drops the whole bundle ───────────────────
const peers = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).peerDependencies
// The anchor is the installed dsh's own manifest: up one level is the `dsh` package
// directory, up two the store's `node_modules` that every peer sits in.
const storeRoot = resolve(dirname(anchor), '..', '..')
const drifted = Object.entries(peers).filter(([name, declared]) => {
  const manifest = join(storeRoot, name, 'package.json')
  if (!existsSync(manifest)) return true
  return !satisfies(declared, JSON.parse(readFileSync(manifest, 'utf8')).version)
})
check('every declared peer is satisfied by the version the installation carries',
  drifted.length === 0,
  drifted.map(([name, declared]) => `${name} declares ${declared}`).join(', ')
    || Object.entries(peers).map(([name, declared]) => `${name.split('/').pop()}@${declared}`).join(', '))

// ── optional: record the live standard roster for generation-time filter checks ───
if (process.env.ZCODE_RECORD_ROSTER === '1' && failures.length === 0) {
  writeFileSync(ROSTER_FILE, `${JSON.stringify({
    recordedFrom: 'standard preset, live boot',
    platform: process.platform,
    tools: standard.tools,
  }, null, 2)}\n`)
  process.stdout.write(`NOTE recorded ${standard.tools.length} standard tool names (${process.platform}) to scripts/roster.standard.json\n`)
} else if (existsSync(ROSTER_FILE)) {
  const recorded = JSON.parse(readFileSync(ROSTER_FILE, 'utf8'))
  // The roster is platform-specific: win32 mounts pwsh where linux mounts bash, so a
  // comparison across platforms says nothing about drift and must say so instead of failing.
  if (recorded.platform === process.platform) {
    const same = recorded.tools.join(',') === standard.tools.join(',')
    check('the live standard roster still matches the recorded roster', same,
      same ? `${recorded.tools.length} names` : `live ${standard.tools.length} vs recorded ${recorded.tools.length}`)
  } else {
    process.stdout.write(`NOTE roster comparison skipped: recorded on ${recorded.platform}, running on ${process.platform}\n`)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
process.stdout.write(`\nverify-mount: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`}\n`)
if (failures.length > 0) process.exitCode = 1
