#!/usr/bin/env node
/**
 * unit-guard.mjs — the pure-function gate for `src/verification-guard.js`.
 *
 * Everything here is decidable without a dsh boot: the fold over committed
 * events, the exit-code reader, the subagent filter, and the steering text.
 * The live half (the row mounts, the projection registers, the check fires) is
 * `verify-mount.mjs`.
 *
 * The exit-code cases mirror the renderer's actual contract
 * (`packages/shell/tool-bash/src/render.ts`): a non-zero exit appends exactly
 * `[exit code: N]`, exit 0 appends no marker, and timeout/stop/signal/
 * background-start are different marker families that must NOT count as a
 * successful verification. Those are the negatives that make the guard worth
 * having — a guard that treats an unrun command as success is the hallucination
 * it is supposed to stop.
 */

import assert from 'node:assert/strict'

import {
  MAX_FAILURES, PROJECTION_KEY, apply, emptyState, exitCodeOf, fold, isSuccessfulShell, isTopLevel, steerText,
  validateCap,
} from '../src/verification-guard.js'

let passed = 0
const failures = []

/**
 * Run one case and record it.
 * @param {string} name case name
 * @param {() => void} body assertions
 */
function test(name, body) {
  try {
    body()
    passed += 1
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    const line = `FAIL ${name} — ${error.message}`
    failures.push(line)
    process.stdout.write(`${line}\n`)
  }
}

/** A committed `tool/call` event for one call id. */
const call = (callId, name, turn = 1) => ({
  type: 'tool/call',
  seq: 0,
  time: 0,
  data: { turn, step: 1, callId, name, arguments: '{}' },
})

/** A committed `tool/result` event for one call id. */
const result = (callId, text, { isError = false, turn = 1 } = {}) => ({
  type: 'tool/result',
  seq: 0,
  time: 0,
  data: {
    turn,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      isError,
      content: [{ type: 'text', text }],
    },
  },
})

/** Fold a sequence of events from a fresh state. */
const run = events => events.reduce(fold, emptyState())

// ── exit-code reading ──────────────────────────────────────────────────────────
test('a zero exit carries no marker and is read as 0', () => {
  assert.equal(exitCodeOf('all green\n'), 0)
  assert.equal(isSuccessfulShell('all green\n'), true)
})
test('a non-zero exit marker is read as that number', () => {
  assert.equal(exitCodeOf('boom\n[exit code: 1]'), 1)
  assert.equal(isSuccessfulShell('boom\n[exit code: 1]'), false)
  assert.equal(isSuccessfulShell('[exit code: 127]'), false)
})
test('a timeout is not a completed verification', () => {
  assert.equal(exitCodeOf('partial\n[timed out after 5000ms]'), undefined)
  assert.equal(isSuccessfulShell('[timed out after 5000ms]'), false)
})
test('a stopped or killed call is not a completed verification', () => {
  assert.equal(exitCodeOf('[stopped: by the user]'), undefined)
  assert.equal(isSuccessfulShell('[killed by signal: SIGTERM]'), false)
})
test('a background acknowledgement is not a completed verification', () => {
  assert.equal(exitCodeOf('started background job job-1'), undefined)
  assert.equal(isSuccessfulShell('started background job job-1'), false)
})

// ── the fold ──────────────────────────────────────────────────────────────────
test('an untouched turn is neither mutated nor verified', () => {
  const state = run([{ type: 'turn/start', data: { turn: 1 } }])
  assert.equal(state.mutated, false)
  assert.equal(state.verified, false)
})
test('a successful edit marks the turn mutating', () => {
  const state = run([call('c1', 'edit'), result('c1', 'ok')])
  assert.equal(state.mutated, true)
  assert.equal(state.verified, false)
})
test('a FAILED edit does not mark the turn mutating', () => {
  const state = run([call('c1', 'edit'), result('c1', 'cannot modify: not read', { isError: true })])
  assert.equal(state.mutated, false)
})
test('a read does not mark the turn mutating', () => {
  const state = run([call('c1', 'read'), result('c1', 'file text')])
  assert.equal(state.mutated, false)
})
test('a successful shell call verifies the turn', () => {
  const state = run([call('c1', 'edit'), result('c1', 'ok'), call('c2', 'bash'), result('c2', 'ok\n')])
  assert.equal(state.verified, true)
})
test('a failing shell call does not verify, and is recorded', () => {
  const state = run([call('c1', 'edit'), result('c1', 'ok'), call('c2', 'bash'), result('c2', 'FAIL\n[exit code: 1]')])
  assert.equal(state.verified, false)
  assert.deepEqual(state.failures, ['bash'])
})
test('an isError shell result does not verify even with clean text', () => {
  const state = run([call('c1', 'bash'), result('c1', 'looks fine', { isError: true })])
  assert.equal(state.verified, false)
  assert.deepEqual(state.failures, ['bash'])
})
test('the failure list is bounded', () => {
  const events = []
  for (let index = 0; index < MAX_FAILURES + 2; index += 1) {
    events.push(call(`c${index}`, 'bash'), result(`c${index}`, '[exit code: 1]'))
  }
  const state = run(events)
  assert.equal(state.failures.length, MAX_FAILURES)
})
test('a result with no matching call is ignored rather than guessed', () => {
  const state = run([result('orphan', 'ok')])
  assert.equal(state.mutated, false)
  assert.equal(state.verified, false)
})
test('the call map drops each id once its result arrives', () => {
  const state = run([call('c1', 'bash'), result('c1', 'ok')])
  assert.deepEqual(state.calls, {})
})
test('a new turn resets the facts', () => {
  const state = run([
    { type: 'turn/start', data: { turn: 1 } },
    call('c1', 'edit'), result('c1', 'ok'),
    { type: 'turn/start', data: { turn: 2 } },
  ])
  assert.equal(state.mutated, false)
  assert.equal(state.verified, false)
  assert.equal(state.failures.length, 0)
  assert.equal(state.continuations, 0)
})
test('a repeated turn/start for the same turn is a no-op reference', () => {
  const first = run([{ type: 'turn/start', data: { turn: 1 } }, call('c1', 'edit'), result('c1', 'ok')])
  const second = fold(first, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(second, first)
})
test('uninteresting events preserve the state reference', () => {
  const state = emptyState()
  assert.equal(fold(state, { type: 'assistant/message', data: {} }), state)
})
test('the guard counts its own steering messages as forced continuations', () => {
  const state = run([{
    type: 'user/message',
    data: { source: { kind: 'zcode-verification-guard', form: 'notice', summary: 'verification missing' } },
  }])
  assert.equal(state.continuations, 1)
})
test('a user prompt is not counted as a forced continuation', () => {
  const state = run([{ type: 'user/message', data: { source: { kind: 'user' } } }])
  assert.equal(state.continuations, 0)
})

// ── the subagent filter ──────────────────────────────────────────────────────
test('a top-level agent is enforced', () => {
  assert.equal(isTopLevel({ session: { header: {} }, options: {} }), true)
  assert.equal(isTopLevel({ session: { header: { delegationDepth: 0 } }, options: {} }), true)
})
test('a persisted child depth is not enforced', () => {
  assert.equal(isTopLevel({ session: { header: { delegationDepth: 1 } }, options: {} }), false)
})
test('a runtime-only child depth is not enforced either', () => {
  assert.equal(isTopLevel({ session: { header: {} }, options: { subagentDepth: 1 } }), false)
})
test('the deeper of header and runtime wins, as in the subagent package', () => {
  assert.equal(isTopLevel({ session: { header: { delegationDepth: 2 } }, options: { subagentDepth: 1 } }), false)
})

// ── config and text ──────────────────────────────────────────────────────────
test('a valid cap is accepted and an invalid one throws', () => {
  assert.equal(validateCap(0), 0)
  assert.equal(validateCap(3), 3)
  assert.throws(() => validateCap(-1), /invalid maxContinuations/)
  assert.throws(() => validateCap(1.5), /invalid maxContinuations/)
})
test('the steering text names what ran and what is missing', () => {
  const noShell = steerText({ ...emptyState(), mutated: true })
  assert.match(noShell, /No shell command ran at all/)
  const failed = steerText({ ...emptyState(), mutated: true, failures: ['bash'] })
  assert.match(failed, /exited non-zero \(bash\)/)
  assert.match(failed, /exit code/)
})
test('the projection key is the documented host-only key', () => {
  assert.equal(PROJECTION_KEY, 'zcodeVerification')
})

// ── the wiring: what the plugin does at a real stopping boundary ─────────────
//
// `apply` needs only three things from its context: `sessionProjections`,
// `on`, and `logger`. A hand-built stand-in can therefore drive the whole
// decision path without a boot, which is the point — the negatives below are
// the behaviour the plugin exists for, and they must fail loudly if the
// wiring changes.
const fakeCtx = (state) => {
  const listeners = {}
  const registered = []
  return {
    registered,
    sessionProjections: {
      register: definition => { registered.push(definition); return () => {} },
      stateOf: () => state,
    },
    on: (event, listener) => { listeners[event] = listener },
    logger: { info: () => {}, warn: () => {} },
    fire: (event, payload) => listeners[event]?.(payload),
  }
}

/** A throwaway agent whose only meaningful parts are the header and the steer sink. */
const fakeAgent = (depth = 0) => ({
  session: { header: { delegationDepth: depth } },
  options: {},
  steered: [],
  steer(message) { this.steered.push(message) },
})

test('the guard registers its projection under the documented key', () => {
  const ctx = fakeCtx(emptyState())
  apply(ctx, { enabled: true, maxContinuations: 1 })
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].key, PROJECTION_KEY)
  assert.equal(ctx.registered[0].stateVersion, 1)
})

test('disabled config registers nothing and listens to nothing', () => {
  const ctx = fakeCtx(emptyState())
  apply(ctx, { enabled: false, maxContinuations: 1 })
  assert.equal(ctx.registered.length, 0)
  assert.equal(ctx.fire('agent/turn-stopping', { agent: fakeAgent(), turn: 1 }), undefined)
})

test('an unverified editing turn is steered back', () => {
  const state = { ...emptyState(), turn: 1, mutated: true }
  const ctx = fakeCtx(state)
  apply(ctx, { enabled: true, maxContinuations: 1 })
  const agent = fakeAgent()
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1)
  assert.match(agent.steered[0].content[0].text, /no completed verification step/i)
  assert.equal(agent.steered[0].source.kind, 'zcode-verification-guard')
})

test('a verified turn is left alone', () => {
  const state = { ...emptyState(), turn: 1, mutated: true, verified: true }
  const ctx = fakeCtx(state)
  apply(ctx, { enabled: true, maxContinuations: 1 })
  const agent = fakeAgent()
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

test('a read-only turn is left alone', () => {
  const state = { ...emptyState(), turn: 1, mutated: false }
  const ctx = fakeCtx(state)
  apply(ctx, { enabled: true, maxContinuations: 1 })
  const agent = fakeAgent()
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

test('a subagent turn is left alone even when unverified', () => {
  const state = { ...emptyState(), turn: 1, mutated: true }
  const ctx = fakeCtx(state)
  apply(ctx, { enabled: true, maxContinuations: 1 })
  const agent = fakeAgent(1)
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

test('the cap stops the second forced continuation', () => {
  const state = { ...emptyState(), turn: 1, mutated: true, continuations: 1 }
  const ctx = fakeCtx(state)
  apply(ctx, { enabled: true, maxContinuations: 1 })
  const agent = fakeAgent()
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

test('maxContinuations 0 makes the guard a pure observer', () => {
  const state = { ...emptyState(), turn: 1, mutated: true }
  const ctx = fakeCtx(state)
  apply(ctx, { enabled: true, maxContinuations: 0 })
  const agent = fakeAgent()
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

process.stdout.write(`\nunit-guard: ${failures.length === 0 ? `ALL PASS (${passed})` : `${failures.length} FAILURE(S)`}\n`)
if (failures.length > 0) process.exitCode = 1
