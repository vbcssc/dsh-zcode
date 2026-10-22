/**
 * real-channel.mjs — boot a dsh profile through the LAUNCHER's own code path.
 *
 * "Real channel" means the same path a launcher takes: resolve the profile's
 * bundle layers from disk (`loadProfileDirectory`), compose them
 * (`composeEntries`), then `boot()` the tree with the launcher's wiring. That is
 * what makes the assembled prompt and the RUNTIME tool registry observable;
 * `dsh --dump-config` only proves composition, and an in-process fixture never
 * mounts a bundle at all.
 *
 * Three launcher mechanisms cannot be guessed, because a programmatic boot with
 * the obvious arguments fails without them:
 *
 *   1. Module resolution. `boot()` alone leaves every bare specifier
 *      unresolved. The tree needs `PluginPackages` mounted with
 *      `createRuntimeResolution(...)`, which turns package names into absolute
 *      directories for plugin code AND for the plugins' own imports.
 *   2. `hmr` refuses to activate without an `appReady` service, and a failed
 *      required row rejects the whole boot. `provideCmdline` supplies
 *      `appReady` (with `cmdlineArgs` and `appExit`).
 *   3. `llm-deepseek` calls `environment.get(...)`, so a real
 *      `LaunchEnvironmentSnapshot` must be provided before entries mount; a
 *      plain `process.env` object is not that shape.
 *
 * TWO PROPERTIES THIS MODULE DELIBERATELY KEEPS:
 *
 *  - Nothing here is specific to another repository. The bundle under test, the
 *    home, and the boot working directory all come from the caller; the install
 *    anchor comes from the dsh installation. A checkout that is renamed, moved,
 *    or has never been installed can still boot its own bundle.
 *  - The launcher packages are loaded dynamically, resolved FROM THE
 *    INSTALLATION. This repository ships no devDependencies, so a static
 *    `import '@deepseek-ai/dsh-app-boot'` would demand a local install the
 *    package never has. Resolving through the installation also means the boot
 *    sees every package the launcher supplies — including ones like `zod` and
 *    `@deepseek-ai/dsh-llm` that `@deepseek-ai/dsh` does not declare directly
 *    but the runtime resolver hands to plugin code anyway.
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Whether a path exists, without throwing on an unreadable parent. */
function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Read a directory, treating an absent one as empty. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** A manifest's `version`, or '' when unreadable — an unreadable candidate loses. */
function manifestVersion(manifest) {
  try {
    return String(JSON.parse(readFileSync(manifest, 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

/** The highest-versioned candidate's manifest, or undefined. */
function newestManifest(candidates) {
  return candidates
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
    .map(entry => entry.manifest)[0]
}

/** The installation the `dsh` command actually runs, read from its shim. */
function fromShim() {
  const binDir = join(homedir(), 'AppData', 'Local', 'pnpm', 'bin')
  for (const shim of ['dsh.CMD', 'dsh']) {
    let text
    try {
      text = readFileSync(join(binDir, shim), 'utf8')
    } catch {
      continue
    }
    const match = text.match(/node_modules[\\/]@deepseek-ai[\\/]dsh[\\/](?:lib|src)[\\/]bin\.js/i)
    if (match === null) continue
    const packageDir = match[0].replace(/[\\/](?:lib|src)[\\/]bin\.js$/i, '')
    // The shim path is relative to the bin directory (`..\global\v11\<hash>\...`).
    const candidate = resolve(binDir, packageDir, 'package.json')
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * pnpm's `store/v11/links` index: one entry per package NAME, one directory per
 * exact version, each holding that package's own resolved `node_modules`.
 *
 * This fallback matters on a machine whose global store was wiped: `links`
 * keeps the installation's file tree, so a complete dsh app stays bootable even
 * though `global/v11/<hash>` no longer exists.
 * @returns the anchor manifest path, or undefined when the index holds no dsh.
 */
function fromStoreLinks() {
  const base = join(homedir(), 'AppData', 'Local', 'pnpm', 'store', 'v11', 'links', '@deepseek-ai', 'dsh')
  const found = []
  for (const version of readdirSafe(base)) {
    for (const hash of readdirSafe(join(base, version))) {
      const manifest = dshManifestUnder(join(base, version, hash))
      if (exists(manifest)) found.push({ manifest, version: manifestVersion(manifest) })
    }
  }
  return newestManifest(found)
}

/** Every `@deepseek-ai/dsh` installation under pnpm's global store, newest first. */
function fromGlobalStore() {
  const base = join(homedir(), 'AppData', 'Local', 'pnpm', 'global')
  const found = []
  for (const version of readdirSafe(base)) {
    for (const hash of readdirSafe(join(base, version))) {
      const manifest = dshManifestUnder(join(base, version, hash))
      if (exists(manifest)) found.push({ manifest, version: manifestVersion(manifest) })
    }
  }
  return newestManifest(found)
}

/** The `@deepseek-ai/dsh` manifest under a store directory's `node_modules`. */
function dshManifestUnder(storeDir) {
  return join(storeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

/**
 * Absolute `package.json` path of the installed `dsh`, which every profile
 * resolver needs as its installation anchor.
 *
 * Derived, never hardcoded. `$DSH_INSTALL_ANCHOR` wins, then the `dsh` shim (it
 * names the exact installation the command runs — pnpm's content-addressed
 * layout lets several copies of one version coexist, so picking "some 0.2.0-rc.2"
 * could anchor the boot at a different store than the CLI uses), then the
 * store's `links` index, then the global store.
 * @returns the anchor `package.json` path.
 * @throws when no installation can be located, naming the override to set.
 */
export function discoverInstallAnchor() {
  const override = process.env.DSH_INSTALL_ANCHOR
  if (override !== undefined && override !== '') {
    if (!exists(override)) throw new Error(`DSH_INSTALL_ANCHOR does not exist: ${override}`)
    return override
  }
  for (const find of [fromShim, fromStoreLinks, fromGlobalStore]) {
    const found = find()
    if (found !== undefined) return found
  }
  throw new Error(
    'cannot locate the dsh installation; set DSH_INSTALL_ANCHOR to its package.json '
    + '(the one the `dsh` command runs: <store>/node_modules/@deepseek-ai/dsh/package.json)',
  )
}

/**
 * Load the launcher packages the boot needs, resolved FROM THE INSTALLATION.
 *
 * `installAnchor` is a file inside the dsh app package, so a `require` anchored
 * there resolves the app's own dependencies exactly as the launcher's would.
 * That is why this repository needs no devDependencies to run the gate, and why
 * the result follows whichever installation `discoverInstallAnchor` picked.
 * Every failure names the package and the anchor, because the likely cause is an
 * incomplete installation rather than a bad import.
 * @param anchor - the anchor `package.json` path.
 * @returns the launcher functions plus the installed dsh version.
 */
export async function loadLauncher(anchor) {
  const { createRequire } = await import('node:module')
  const fromAnchor = createRequire(anchor)
  const load = async name => {
    let entry
    try {
      entry = fromAnchor.resolve(name)
    } catch (error) {
      throw new Error(
        `cannot resolve ${name} from the dsh installation at ${anchor} `
        + `(${error.code ?? error.message}); set DSH_INSTALL_ANCHOR to a complete installation`,
      )
    }
    return import(pathToFileURL(entry).href)
  }
  const [appBoot, cmdline, launch] = await Promise.all([
    load('@deepseek-ai/dsh-app-boot'),
    load('@deepseek-ai/dsh-cmdline'),
    load('@deepseek-ai/dsh-launch-environment'),
  ])
  return {
    boot: appBoot.boot,
    PluginPackages: appBoot.PluginPackages,
    createRuntimeResolution: appBoot.createRuntimeResolution,
    loadProfileDirectory: appBoot.loadProfileDirectory,
    readProfilePatches: appBoot.readProfilePatches,
    provideCmdline: cmdline.provideCmdline,
    DSH_LAUNCH_ENVIRONMENT_KEY: launch.DSH_LAUNCH_ENVIRONMENT_KEY,
    createLaunchEnvironmentSnapshot: launch.createLaunchEnvironmentSnapshot,
    version: JSON.parse(readFileSync(join(anchor, '..', 'package.json'), 'utf8')).version,
  }
}

/**
 * Whether this installation's own native loader is unusable AND the boot needs it.
 *
 * `@deepseek-ai/cordis-plugin-loader` reaches Node's internals through the
 * `node-addon-require-builtin` native addon, which loads a per-platform binary
 * package. In pnpm's isolated layout that binary package can sit where the addon's
 * own `require` cannot see it, and the addon then throws "No usable native binding
 * found".
 *
 * That failure is NOT automatically fatal: the loader wraps the addon in a
 * try/catch and falls back to Node's documented path when the internals are
 * unreachable. Probing the addon in isolation therefore says nothing about
 * whether a boot will succeed, and refusing to run on it would turn a supported
 * fallback into a hard failure. This check exists only to explain an
 * already-failed boot, so it does not gate the run.
 * @param anchor - the anchor `package.json` path.
 * @returns undefined when the addon loads, else a reason string.
 */
export async function nativeLoaderProblem(anchor) {
  const { createRequire } = await import('node:module')
  const fromAnchor = createRequire(anchor)
  let entry
  try {
    entry = fromAnchor.resolve('node-addon-require-builtin')
  } catch {
    // Not every installation shape carries the addon; the loader has a path for
    // that too, so its absence is not a failure.
    return undefined
  }
  try {
    createRequire(entry)('node-addon-require-builtin').requireBuiltin('internal/modules/esm/loader')
    return undefined
  } catch (error) {
    return `${error.message.split('\n')[0]} (resolved at ${entry})`
  }
}

/** Recursively copy a tree, giving every file a fresh inode. */
export function copyTree(source, target) {
  const stats = statSync(source)
  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry))
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
}

/**
 * Copy one profile directory into a private home so mutations cannot reach the
 * source repository through the hard links a `file:` install created.
 *
 * `file:` installs hard link rather than copy, so editing the profile's copy in
 * place writes THROUGH to the bundle's working tree. Every mutation therefore
 * starts from a byte copy with fresh inodes.
 * @param sourceDir - profile directory to clone.
 * @param targetDir - profile directory to create.
 */
export function detachProfile(sourceDir, targetDir) {
  rmSync(targetDir, { recursive: true, force: true })
  copyTree(sourceDir, targetDir)
}

/**
 * Assert two paths are not hard links to the same inode.
 * @param detachedFile - the file in the private copy.
 * @param sourceFile - the same file in the shared profile.
 */
export function assertDetached(detachedFile, sourceFile) {
  const a = statSync(detachedFile)
  const b = statSync(sourceFile)
  if (a.ino === b.ino) {
    throw new Error(`detach failed: ${detachedFile} and ${sourceFile} share inode ${a.ino}`)
  }
}

/** A signal the booted host asked to exit with; never surfaced to a test runner. */
const exits = []

/**
 * Boot a composed profile directory exactly as the launcher does.
 *
 * Entries whose services this host does not provide stay inactive rather than
 * failing the boot (the web surface's transport rows wait for connections no
 * test opens), so `boot` returns a live context with a partially activated tree.
 * `hmr` IS required, which is why `appReady` must be supplied.
 * @param options - launcher functions, profile directory, isolated home, anchor,
 *   boot working directory, profile name, and the command line to pretend was passed.
 * @returns the booted root context and the resolved profile.
 */
export async function bootProfile({
  launcher, dir, home, anchor, cwd, name = 'web', args = ['--no-open', '--port', '0'],
}) {
  const profile = launcher.loadProfileDirectory('dsh', dir, anchor)
  const resolution = await launcher.createRuntimeResolution({ installAnchor: anchor, profile })
  const profileContext = {
    name,
    dir,
    patchPath: profile.patchPath,
    installAnchor: anchor,
    startedBundles: profile.layers.map(layer => layer.packageName),
    cwd,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const environment = launcher.createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const appReady = { listeners: new Set(), ready: false }
  const ctx = await launcher.boot(
    'dsh',
    join(dir, 'cordis.yml'),
    launcher.readProfilePatches('dsh', profileContext, profile),
    async hostCtx => {
      hostCtx.provide('profileContext', profileContext)
      hostCtx.provide(launcher.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      await hostCtx.plugin(launcher.PluginPackages, { resolution })
      launcher.provideCmdline(hostCtx, {
        args: [...args],
        exit: code => {
          exits.push(code)
        },
        ready: {
          onReady(listener) {
            if (appReady.ready) {
              listener()
              return () => {}
            }
            appReady.listeners.add(listener)
            return () => appReady.listeners.delete(listener)
          },
        },
      })
    },
  )
  // Commit readiness only after the tree settles, mirroring the launcher: rows
  // that gate on application readiness (hmr) stay inactive until then.
  appReady.ready = true
  for (const listener of [...appReady.listeners]) listener()
  appReady.listeners.clear()
  return { ctx, profile }
}

/** Distinguishes the throwaway Agents {@link readPresetLive} creates. */
let presetProbeCounter = 0

/**
 * One preset's model-visible surface, read from a LIVE Agent.
 *
 * Read through an Agent, not `acquireScope`. Since 0.2.1 a delegation row
 * configured with `agentPreset` registers its tool AND its guidance section
 * inside each live Agent's own scope (`tool-subagent/src/index.ts:444-515`: the
 * standing composition keys `scopedInstalls` by Agent), so the preset scope
 * alone reports a table without the delegation tools and an assembly without
 * their `tool:subagent_*` sections — which would make the "added exactly the
 * named subagents" checks vacuous rather than failing.
 *
 * The Agent is created with the preset mounted in its setup — the same call
 * `session-controller`'s `composeAgent` makes — and read exactly as the loop
 * reads it: `schemas(agent)` for the tool table and
 * `assemble({ agent, scope: agent })` for the prompt. It is disposed before
 * returning so repeated reads cannot accumulate Agents.
 * @param ctx - booted root context.
 * @param preset - preset id to read.
 * @returns visible tool names, the `subagent_*` schemas, the assembled sections
 *   and the resolved persona prefix.
 */
export async function readPresetLive(ctx, preset) {
  const presets = ctx.get('agentPresets')
  const agents = ctx.get('agents')
  const handle = await agents.create({
    // The booted profile persists sessions, so a fixed id collides on the
    // second read in one process and on every later run. The counter keeps the
    // id readable; the random suffix keeps it unique across runs.
    sessionId: `preset-probe-${preset}-${++presetProbeCounter}-${randomUUID()}`,
    setup: async agentCtx => { await presets.mount(agentCtx, preset) },
  })
  try {
    const schemas = ctx.get('tools').schemas(handle.agent)
    const assembly = await ctx.get('systemPrompt').assemble({ agent: handle.agent, scope: handle.agent })
    return {
      tools: schemas.map(schema => schema.name).sort(),
      subagents: schemas
        .filter(schema => schema.name.startsWith('subagent_'))
        .map(schema => ({ name: schema.name, chars: schema.description.length, description: schema.description })),
      assembly: {
        sections: assembly.sections.map(section => ({ name: section.name, chars: section.text.length })),
        // The section texts concatenated, which is what the model receives; the
        // harness's own renderPrompt() additionally interpolates `{{variables}}`,
        // which is a separate step from assembly and not compared here.
        text: assembly.sections.map(section => section.text).join(''),
      },
      persona: assembly.sections.find(section => section.name === 'deployment:persona-prefix')?.text,
    }
  } finally {
    await handle.dispose()
  }
}

/** Preset ids and activation diagnostics from the live registry. */
export async function presetList(ctx) {
  return (await ctx.get('agentPresets').list()).map(entry => ({
    id: entry.id,
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
  }))
}
