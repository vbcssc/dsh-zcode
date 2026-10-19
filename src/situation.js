/**
 * zcode-situation — the situational layer the shipped harness prompt leaves out.
 *
 * dsh's model-facing prompt says which tools exist and what the deployment is
 * called; it does not say what platform the agent is running on, which repository
 * state it is standing in, or what day it is. ZCode injects all three at the start
 * of every session, which is the second of the three gaps this bundle closes.
 *
 * Mechanism. Each fact is one `SystemPrompt.context()` contribution
 * (core/system-prompt/src/index.ts): a `text` provider re-evaluated at every
 * assembly, joined into the runtime-context snapshot the loop delivers as a
 * durable user-role message. Three properties of that channel shape this file:
 *
 *   - The loop only writes a new snapshot when the rendered text CHANGED
 *     (agent-loop/runtime-context.ts `project`: `retained.text === current` returns
 *     early). So nothing here may vary per turn for no reason — no timestamps with
 *     seconds, no iteration counters. A chatty provider would grow the log every step.
 *   - Context text is interpolated like every other prompt input
 *     (`interpolate()`): a complete `{{name}}` group whose name is not registered
 *     THROWS, and a `{{` with a later `}}` throws as malformed. Repository content is
 *     exactly the kind of text that can contain those bytes — a Handlebars fixture
 *     named `{{item}}.hbs` shows up in `git status` output — so every dynamic piece
 *     goes through `braceSafe()` before it reaches the prompt.
 *   - `order` is a free finite number for external contributions
 *     (core/system-prompt/README.md: "External contributions may use any finite
 *     order"). The harness reserves 110/115/120 for sandbox, approval, and
 *     delegation; this bundle sits at 130/135/140, after all three and before any
 *     tool section.
 *
 * What is deliberately NOT restated here: the working directory. The shipped
 * persona suffix already renders `Your working directory is {{cwd}}.` and this
 * bundle's preset keeps that suffix, so repeating it would put the same fact in two
 * places the model has to reconcile.
 *
 * Git probing. The provider runs synchronously — `context()` accepts a string
 * return, not a promise — so it uses `node:child_process` synchronously rather than
 * the `shell` service, whose execution is asynchronous and which is the tool plane,
 * not the prompt plane. Arguments are constant arrays, the working directory is
 * passed as `cwd` rather than interpolated, and a probe that fails contributes
 * nothing instead of a guess: a wrong repository fact in the prompt is worse than an
 * absent one, which is the same rule the launcher's own environment capture follows.
 *
 * @module dsh-zcode-mode/situation
 */

import z from '@deepseek-ai/schemastery'
import { execFileSync } from 'node:child_process'
import { arch, release } from 'node:os'

/** Cordis plugin name. */
export const name = 'zcode-situation'

/** The service this plugin needs; the row activates only once it exists. */
export const inject = ['systemPrompt']

/** Positions in the runtime-context snapshot, after the harness's own three. */
export const CONTEXT_ORDERS = { environment: 130, repository: 135, date: 140 }

/**
 * `gitTimeoutMs: 0` is accepted and means every probe fails immediately, i.e. the
 * repository block contributes nothing; `git: false` is the switch to reach for.
 */
export const Config = z.object({
  environment: z.boolean().default(true),
  git: z.boolean().default(true),
  date: z.boolean().default(true),
  gitTimeoutMs: z.natural().default(3000),
  gitMaxChars: z.natural().default(2000),
  /** Reuse one probe result inside this window, per session. */
  cacheMs: z.natural().default(20000),
})

/** The git commands this file may run. Constant argv, one entry per fact. */
export const GIT_ARGV = {
  inside: ['rev-parse', '--is-inside-work-tree'],
  branch: ['rev-parse', '--abbrev-ref', 'HEAD'],
  originHead: ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
  user: ['config', 'user.name'],
  status: ['--no-optional-locks', 'status', '--short'],
  log: ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
}

/** Candidate default-branch names, tried in order when the remote HEAD is unset. */
export const MAIN_BRANCH_CANDIDATES = ['main', 'master']

/**
 * Make text safe to place inside an interpolated prompt input.
 *
 * Only the opening pair matters: `interpolate()` scans for `{{` and throws when it
 * finds a well-formed-but-unregistered group or an unmatched `{{` with a later `}}`.
 * Splitting the pair to `{ {` keeps the text readable and removes both paths.
 * @param value - the raw dynamic text.
 * @returns the text with every `{{` broken apart.
 */
export function braceSafe(value) {
  return value.replaceAll('{{', '{ {')
}

/**
 * Run one constant-argv git command and report only success.
 * @param args - argv for `git`.
 * @param cwd - repository directory to run in.
 * @param timeoutMs - per-command budget.
 * @returns trimmed stdout, or `undefined` when the command failed or timed out.
 */
function gitRun(args, cwd, timeoutMs) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // A failed probe is silence, never a guess and never the command's stderr:
    // unreliable error text has no business reaching the model-visible surface.
    return undefined
  }
}

/**
 * Resolve the branch a pull request would target.
 * @param cwd - repository directory.
 * @param timeoutMs - per-command budget.
 * @returns the branch name, or `undefined` when none can be established.
 */
function resolveMainBranch(cwd, timeoutMs) {
  const symbolic = gitRun(GIT_ARGV.originHead, cwd, timeoutMs)
  const stripped = symbolic?.replace(/^origin\//, '')
  const candidates = stripped === undefined || stripped === ''
    ? MAIN_BRANCH_CANDIDATES
    : [stripped, ...MAIN_BRANCH_CANDIDATES.filter(c => c !== stripped)]
  for (const candidate of candidates) {
    if (gitRun(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], cwd, timeoutMs) !== undefined) {
      return candidate
    }
    // No remote-tracking ref: a local branch of that name still answers the question.
    if (gitRun(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], cwd, timeoutMs) !== undefined) {
      return candidate
    }
  }
  return candidates[0]
}

/**
 * Collect the repository snapshot for one directory.
 * @param cwd - the session's working directory.
 * @param config - resolved plugin config.
 * @returns the rendered block, or `''` when this is not a repository or nothing resolved.
 */
export function repositoryBlock(cwd, config) {
  if (cwd === undefined || cwd === '') return ''
  if (gitRun(GIT_ARGV.inside, cwd, config.gitTimeoutMs) !== 'true') return ''
  const branch = gitRun(GIT_ARGV.branch, cwd, config.gitTimeoutMs) ?? 'HEAD'
  const main = resolveMainBranch(cwd, config.gitTimeoutMs)
  const user = gitRun(GIT_ARGV.user, cwd, config.gitTimeoutMs)
  const status = gitRun(GIT_ARGV.status, cwd, config.gitTimeoutMs)
  const log = gitRun(GIT_ARGV.log, cwd, config.gitTimeoutMs)
  const budget = config.gitMaxChars
  const statusText = status === undefined || status === ''
    ? '(clean)'
    : status.length > budget
      ? `${status.slice(0, budget)}\n... (truncated at ${budget} characters; run the status command for the whole listing)`
      : status
  const lines = [
    '# Repository state',
    `Current branch: ${braceSafe(branch)}`,
    main === undefined ? undefined : `Main branch (pull requests usually target it): ${braceSafe(main)}`,
    user === undefined ? undefined : `Git user: ${braceSafe(user)}`,
    'Status (short form, snapshot of this moment):',
    braceSafe(statusText),
  ]
  if (log !== undefined && log !== '') lines.push('Recent commits:', braceSafe(log))
  return lines.filter(line => line !== undefined).join('\n')
}

/**
 * Render the platform block. Static for the life of the process except for the
 * version-control line, which is taken from the shared probe rather than a probe of
 * its own: two registrations doing one git call each would double the subprocess
 * cost of every step.
 * @param cwd - the session's working directory, for the presence line.
 * @param isRepository - whether the shared probe found a repository at `cwd`.
 * @returns the block text.
 */
export function environmentBlock(cwd, isRepository) {
  // This bundle's generated patch inverts the shipped standard's shell gates: `bash`
  // is mounted on every platform and `pwsh` on none. On win32 the tool runs Git Bash
  // through the profile's local bash executor (`dsh-git-bash` or equivalent), which
  // INSTALL requires. The line keeps the mounted name the ONLY spelling of it that
  // reaches the model: a capitalized "Git Bash" beside `Terminal tool:` invites the
  // model to invoke the tool as "Bash", which the case-sensitive registry rejects.
  const isWindows = process.platform === 'win32'
  const terminal = isWindows
    ? 'bash (POSIX shell syntax; the pwsh tool is not mounted)'
    : 'bash'
  const lines = [
    '# Environment',
    `Platform: ${process.platform}`,
    `OS: ${release()} ${arch()}`,
    `Terminal tool: ${terminal}`,
  ]
  if (cwd !== undefined && cwd !== '') {
    lines.push(`Under version control: ${isRepository ? 'yes (git)' : 'no'}`)
  }
  return lines.join('\n')
}

/**
 * Render the date block. Date-resolution only: a finer clock would rewrite the
 * runtime-context snapshot on every step for no gain.
 * @param now - injectable for tests; defaults to the current time.
 * @returns the block text.
 */
export function dateBlock(now = new Date()) {
  const pad = part => String(part).padStart(2, '0')
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `Today's date is ${iso} (local time).`
}

/**
 * @typedef {object} ProbeCache
 * @property {number} at epoch milliseconds of the stored probe
 * @property {string} text the block that was rendered from it
 */

/**
 * Register the situational contributions in the calling scope.
 * @param ctx - agent-scoped Cordis context.
 * @param config - resolved {@link Config}.
 */
export function apply(ctx, config) {
  /** Live sessions share the plugin per scope, so the cache is per session id. */
  const probes = new Map()

  /**
   * Read the repository block, re-probing only when the window has passed.
   * @param cwd - the session's working directory.
   * @returns the block text.
   */
  const cachedRepository = cwd => {
    const key = `${cwd ?? ''}`
    const hit = probes.get(key)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < config.cacheMs) return hit.text
    const text = repositoryBlock(cwd, config)
    probes.set(key, { at: now, text })
    return text
  }

  /** @returns the session working directory of the assembly, if it has an agent. */
  const cwdOf = context => context.agent?.session?.header?.cwd

  if (config.environment) {
    ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt.context({
        name: 'zcode:environment',
        order: CONTEXT_ORDERS.environment,
        text: context => environmentBlock(cwdOf(context), cachedRepository(cwdOf(context)) !== ''),
      })
    })
  }
  if (config.git) {
    ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt.context({
        name: 'zcode:repository',
        order: CONTEXT_ORDERS.repository,
        // Empty text contributes nothing, which is how a non-repository session
        // drops this block without unmounting the plugin.
        text: context => cachedRepository(cwdOf(context)),
      })
    })
  }
  if (config.date) {
    ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt.context({
        name: 'zcode:current-date',
        order: CONTEXT_ORDERS.date,
        text: () => dateBlock(),
      })
    })
  }
}
