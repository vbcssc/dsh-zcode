/**
 * zcode-verification-guard — a hard, deterministic check at the turn boundary.
 *
 * The persona says "verify before claiming"; a prompt cannot enforce that, and a
 * `status: DONE` block written by the model is a self-report the harness never
 * cross-checks. This plugin is the part of that contract the harness can check
 * itself, because it is derived from facts the runtime already recorded: which
 * tools ran this turn, whether any of them mutated a file, and whether any
 * shell call actually finished with exit code 0.
 *
 * Contract, in one sentence: a turn that edited or wrote files must also have
 * completed at least one shell command that exited 0; otherwise the turn is not
 * allowed to close and the model is steered back with the facts that are
 * missing.
 *
 * Why a projection rather than a listener-local WeakMap. The facts must survive
 * resume: a session reopened mid-turn must reach the same verdict as the run
 * that produced it. `sessionProjections` derives them from committed events with
 * a pure fold, which is the harness's supported seam for state that must be
 * rebuilt after resume (`time-context` uses the same shape). The synchronous
 * history readers (`snapshotEvents`, `eventAt`, `ownEvents`) are explicitly
 * deprecated for new production calls, so they are not used here.
 *
 * Why the exit code and not `isError`. A non-zero shell exit is NOT a tool
 * error: `tool-bash` reports it as `[exit code: N]` inside a successful result
 * for the model to interpret (`packages/shell/tool-bash/README.md`: "A non-zero
 * exit is reported ... not surfaced as a tool error"). Reading `isError` alone
 * would treat a failing test suite as a successful verification — precisely the
 * hallucination this guard exists to stop — so the fold parses the rendered exit
 * marker out of the committed `tool/result` content instead.
 *
 * Why the call name comes from elsewhere. `tool/result` carries the message and
 * its `callId`, not the tool name; the name lives on the paired `tool/call`
 * event, whose seq the result cites as its first `sourceEventSeqs` entry
 * (`agent-loop/src/tool-calls.ts`). The fold therefore keeps a small
 * callId → name map built from `tool/call`, and drops each entry when its
 * result arrives.
 *
 * Loop safety. Forced continuation is capped (`maxContinuations`, default 1).
 * The cap is enforced by a per-turn counter the fold maintains from the guard's
 * own steering messages, so a resumed turn cannot reset it and force another
 * round. The hooks bridge documents the same hazard as an open TODO ("cap
 * consecutive forced continuations"); this plugin is its own cap.
 *
 * @module dsh-zcode-mode/verification-guard
 */

import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name. */
export const name = 'zcode-verification-guard'

/** The services this plugin needs; the projection registry must exist before it registers. */
export const inject = ['sessionProjections']

/** Tools whose successful execution means the turn changed a file. */
export const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Shell tools whose exit status counts as verification. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** The source kind this plugin stamps on its own steering messages. */
export const STEER_SOURCE = 'zcode-verification-guard'

/**
 * Projection key. Host-only (no `wire` view): `sessionProjections.register`
 * accepts a definition without `wire` only for keys absent from
 * `SessionProjectionMap`, so the state is checkpointed but never sent to a
 * browser. This module is plain runtime JavaScript — the bundle ships `src/`
 * as-is rather than compiling TypeScript — so the matching
 * `SessionProjectionStateMap` augmentation cannot live here; the key is a
 * plain string either way at runtime.
 */
export const PROJECTION_KEY = 'zcodeVerification'

/** The bounded number of failing shell commands retained for the steering text. */
export const MAX_FAILURES = 3

/**
 * Plugin config. `enabled: false` is the switch to reach for in a deployment
 * with no shell tool at all, where every file edit would otherwise be steered.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  /**
   * Forced continuations allowed per turn. `1` means the model is told once; a
   * second stop in the same turn closes it anyway rather than looping forever.
   * `0` turns the guard into a pure observer that never steers.
   */
  maxContinuations: z.natural().default(1),
})

/**
 * The durable per-turn facts the guard folds.
 * @typedef {object} GuardState
 * @property {number} turn the turn these facts belong to; `-1` before the first
 * @property {boolean} mutated whether a mutating tool ran successfully this turn
 * @property {boolean} verified whether a shell call completed with exit code 0
 * @property {string[]} failures failing shell tool names (bounded by {@link MAX_FAILURES})
 * @property {number} continuations how many times this guard forced continuation this turn
 * @property {Record<string, string>} calls unresolved `callId` → tool name
 */

/** @returns {GuardState} the empty state. */
export function emptyState() {
  return { turn: -1, mutated: false, verified: false, failures: [], continuations: 0, calls: {} }
}

/**
 * The text of a model-facing content block array.
 * @param {unknown} content the committed message content blocks
 * @returns {string} the concatenated text blocks
 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Read the exit code a shell result reported, or `undefined` when the result
 * carries no exit marker at all (a background start, a promotion, an aborted
 * call, or an infrastructure error).
 *
 * `tool-bash`'s renderer pushes `[exit code: N]` only for a non-zero exit
 * (`packages/shell/tool-bash/src/render.ts`: the marker is inside the
 * `else if (result.exitCode !== 0)` branch), and pushes nothing for exit 0. So
 * an absent marker on a non-error result means zero. The result is `undefined`
 * only when some other marker proves the call did not complete a normal run.
 * @param {string} text the model-facing result text
 * @returns {number | undefined} the exit code, or undefined when the call did
 *   not complete a normal foreground run
 */
export function exitCodeOf(text) {
  const match = /\[exit code: (-?\d+)\]/.exec(text)
  if (match !== null) return Number(match[1])
  if (/\[timed out after \d+ms\]/.test(text) || /\[stopped: /.test(text)
    || /\[killed by signal: /.test(text) || /^started background job /m.test(text)) {
    return undefined
  }
  return 0
}

/**
 * Whether a shell result text denotes a completed, successful run.
 * @param {string} text the model-facing result text
 * @returns {boolean} true when the call exited 0
 */
export function isSuccessfulShell(text) {
  return exitCodeOf(text) === 0
}

/**
 * Fold one committed session event into the guard state.
 *
 * Pure: the same event always yields the same state, and an uninteresting event
 * returns the very same reference so the projection registry does no downstream
 * work (`Object.is` is its change test).
 * @param {GuardState} state the state covering all prior events
 * @param {{ type: string, data?: any }} event one committed session event
 * @returns {GuardState} the next state
 */
export function fold(state, event) {
  switch (event.type) {
    case 'turn/start': {
      const turn = event.data.turn
      // Every turn starts from zero facts. Keeping `continuations` would let the
      // cap leak across turns; resetting the whole state is the safe direction.
      return state.turn === turn ? state : { ...emptyState(), turn }
    }
    case 'user/message': {
      // The guard's own steering message is the only record that a forced
      // continuation happened, so the durable fold counts them here. Nothing
      // else in the state depends on user messages.
      if (event.data.source?.kind !== STEER_SOURCE) return state
      return { ...state, continuations: state.continuations + 1 }
    }
    case 'tool/call': {
      const { callId, name } = event.data
      if (typeof callId !== 'string' || typeof name !== 'string') return state
      if (state.calls[callId] === name) return state
      return { ...state, calls: { ...state.calls, [callId]: name } }
    }
    case 'tool/result': {
      const message = event.data.message
      const callId = message?.source?.callId
      const toolName = typeof callId === 'string' ? state.calls[callId] : undefined
      if (typeof callId !== 'string' || toolName === undefined) return state
      const calls = { ...state.calls }
      delete calls[callId]
      const isError = message.isError === true
      if (MUTATING_TOOLS.has(toolName)) {
        // A failed edit changed nothing; only a success marks the turn as mutating.
        return { ...state, calls, ...isError ? {} : { mutated: true } }
      }
      if (!SHELL_TOOLS.has(toolName)) return { ...state, calls }
      const text = textOf(message.content)
      const code = isError ? undefined : exitCodeOf(text)
      if (code === 0) return { ...state, calls, verified: true }
      if (state.failures.length >= MAX_FAILURES) return { ...state, calls }
      return { ...state, calls, failures: [...state.failures, toolName] }
    }
    default:
      return state
  }
}

/**
 * Validate `maxContinuations` fail-loud rather than silently clamping, matching
 * the guard family's convention (`repeat-tool-reminder` throws on bad config).
 * @param {unknown} value the resolved config value
 * @returns {number} the validated cap
 */
export function validateCap(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`zcode-verification-guard: invalid maxContinuations ${String(value)} — must be an integer >= 0`)
  }
  return value
}

/**
 * The message the guard steers with. It names the facts rather than lecturing:
 * what the turn did, what is missing, and the one action that settles it.
 * @param {GuardState} state the facts at the stopping boundary
 * @returns {string} model-facing text
 */
export function steerText(state) {
  const failed = state.failures.length > 0
    ? ` The shell call${state.failures.length === 1 ? '' : 's'} that did run exited non-zero (${state.failures.join(', ')}).`
    : ' No shell command ran at all.'
  return 'This turn changed files but contains no completed verification step.'
    + failed
    + ' Before ending the turn, run the command that proves the change works — the test, build, lint, or type check covering what you touched — and read its exit code. '
    + 'If nothing in this environment can verify the change, say so explicitly and name what a reviewer would have to run instead. '
    + 'Do not report the work as done until one of those is true.'
}

/**
 * Whether this agent is a top-level session the guard should enforce.
 *
 * Subagent sessions share the preset but have no user to answer to; forcing a
 * continuation there would stall a delegated task instead of surfacing a false
 * claim. Depth is read the way the subagent package reads it: the persisted
 * header is the monotone floor, and the runtime `options.subagentDepth` may
 * deepen it but never lower it (`subagent/src/depth.ts`, `delegationDepthOf`).
 * Reading only the header would classify an in-process child created without a
 * persisted depth as top-level.
 * @param {any} agent the agent at the stopping boundary
 * @returns {boolean} true for a top-level session
 */
export function isTopLevel(agent) {
  const headerDepth = agent?.session?.header?.delegationDepth ?? 0
  const runtimeDepth = agent?.options?.subagentDepth ?? 0
  return Math.max(headerDepth, runtimeDepth) === 0
}

/**
 * Register the projection and the turn-stopping check.
 * @param {import('@deepseek-ai/cordis').Context} ctx the plugin context
 * @param {typeof Config} config resolved config
 */
export function apply(ctx, config) {
  if (!config.enabled) return
  const cap = validateCap(config.maxContinuations)

  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: zod.object({
      turn: zod.number(),
      mutated: zod.boolean(),
      verified: zod.boolean(),
      failures: zod.array(zod.string()),
      continuations: zod.number(),
      calls: zod.record(zod.string(), zod.string()),
    }),
    init: () => emptyState(),
    apply: fold,
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!isTopLevel(agent)) return
    const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
    if (state === undefined) return
    if (!state.mutated || state.verified) return
    if (state.continuations >= cap) {
      ctx.logger.info(`zcode-verification-guard: turn ${turn} closed unverified after ${state.continuations} forced continuation(s); cap ${cap}`)
      return
    }
    // The fold increments `continuations` when this message is committed, so
    // the next stop boundary in this turn sees the incremented value and does
    // not force a second round.
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: steerText(state) }],
      source: { kind: STEER_SOURCE, form: 'notice', summary: 'verification missing' },
    }))
    ctx.logger.info(`zcode-verification-guard: turn ${turn} edited files without a successful shell call; steered`)
  })
}
