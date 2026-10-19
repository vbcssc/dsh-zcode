#!/usr/bin/env node
/**
 * e2e-guard.mjs — the negative control for `src/verification-guard.js`.
 *
 * `unit-guard.mjs` proves the fold and the decision function in isolation. This
 * script proves the whole thing inside a REAL agent loop: a real Cordis
 * `Context`, the real `AgentLoop`/`ToolRuntime`/`SessionProjectionRegistry`
 * packages, and a scripted LLM adapter. Nothing about the turn machinery is
 * simulated — only the model's output is.
 *
 * The scenario is the exact failure the guard exists for: the model edits a
 * file, runs a shell command that exits non-zero, then tries to end the turn as
 * if the work were done. A guard that merely counts tool calls would wave that
 * through. The expected behaviour is:
 *
 *   1. the turn does NOT close at the first stop;
 *   2. one steering message naming the missing verification is delivered;
 *   3. after the model runs a command that exits 0, the turn closes;
 *   4. a second scripted "I am done" attempt would not produce an infinite
 *      loop — the cap is one forced continuation per turn.
 *
 * It also runs the mirror case: a turn that edits and then verifies once must
 * not be steered at all, so the guard is not simply blocking everything.
 */

import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

import * as Guard from '../src/verification-guard.js'

/** A text-only scripted model response. */
function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, char => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A scripted response that calls one tool. */
function toolCallResponse(callId, name, args) {
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name, argumentsDelta: json.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name, argumentsDelta: json.slice(5) },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: json },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted adapter: one entry per model call, recording every request. */
class MockAdapter extends LlmAdapter {
  constructor(script) {
    super()
    this.script = script
    this.requests = []
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options) {
    this.requests.push(options)
    const next = this.script.shift()
    if (next === undefined) throw new Error('script exhausted')
    for (const chunk of next) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Boot the real loop with the guard mounted. */
async function harness(adapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin({
    name: Guard.name,
    inject: Guard.inject,
    apply: (inner, config) => Guard.apply(inner, config),
  }, { enabled: true, maxContinuations: 1 })
  return ctx
}

/** Resolve when the agent next goes idle. */
function waitForIdle(ctx, agent) {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Fire one user prompt and wait for the turn to settle. */
async function send(agent, text) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Register the stand-in `edit` and `bash` tools; the results are scripted by shellExit. */
function registerTools(ctx, { shellExit }) {
  const runs = { edit: 0, bash: 0 }
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'stand-in edit',
    parameters: { file: { type: 'string', required: true } },
    async execute() {
      runs.edit += 1
      return [{ type: 'text', text: 'edited' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'bash',
    description: 'stand-in shell',
    parameters: { command: { type: 'string', required: true } },
    async execute() {
      runs.bash += 1
      // Mirror tool-bash's renderer exactly: exit 0 emits no marker, a non-zero
      // exit appends `[exit code: N]` to a SUCCESSFUL result. This is the
      // contract the guard parses.
      return [{ type: 'text', text: shellExit === 0 ? 'ok\n' : `suite failed\n[exit code: ${shellExit}]` }]
    },
  }))
  return runs
}

/** The guard's steering messages in the durable log. */
function steerMessages(agent) {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message' && event.data.source.kind === Guard.STEER_SOURCE)
}

let passed = 0
const failures = []
/** Run one scenario and record it. */
async function scenario(name, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    const line = `FAIL ${name} — ${error.message}`
    failures.push(line)
    process.stdout.write(`${line}\n`)
  }
}

// ── 1 · the negative control: edit, failing shell, "I am done" ────────────────
await scenario('an edit plus a FAILING shell does not close the turn, and is steered once', async () => {
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'edit', { file: 'a.txt' }),
    toolCallResponse('c2', 'bash', { command: 'npm test' }),
    textResponse('All done!'),
    // After the forced continuation the model runs a real verification.
    toolCallResponse('c3', 'bash', { command: 'npm test' }),
    textResponse('All done, tests pass now.'),
  ])
  const ctx = await harness(adapter)
  registerTools(ctx, { shellExit: 1 })
  const agent = await ctx.agentLoop.create(SessionId('e2e-1'), { provider: 'mock', model: 'mock' })
  await send(agent, 'change a.txt')
  await waitForIdle(ctx, agent)

  const steered = steerMessages(agent)
  assert.equal(steered.length, 1, 'exactly one forced continuation')
  assert.match(steered[0].data.content[0].text, /no completed verification step/i)
  assert.match(steered[0].data.content[0].text, /exited non-zero/i)
  // Five requests: three scripted steps, the steered verification step, and the
  // follow-up step that closes after it (the loop always re-reads the inbox).
  assert.equal(adapter.requests.length, 5, `requests: ${adapter.requests.length}`)
  // The turn closed normally, not cancelled or failed.
  const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
  assert.equal(end?.data.reason.kind, 'completed')
})

// ── 2 · the mirror: a verified turn is never steered ──────────────────────────
await scenario('an edit plus a PASSING shell closes normally and is never steered', async () => {
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'edit', { file: 'a.txt' }),
    toolCallResponse('c2', 'bash', { command: 'npm test' }),
    textResponse('All done.'),
  ])
  const ctx = await harness(adapter)
  registerTools(ctx, { shellExit: 0 })
  const agent = await ctx.agentLoop.create(SessionId('e2e-2'), { provider: 'mock', model: 'mock' })
  await send(agent, 'change a.txt')
  await waitForIdle(ctx, agent)

  assert.equal(steerMessages(agent).length, 0, 'a verified turn is not steered')
  assert.equal(adapter.requests.length, 3, `requests: ${adapter.requests.length}`)
})

// ── 3 · a failing shell that the model never retries stops after one nudge ────
await scenario('the cap holds: a second unverified stop closes instead of looping', async () => {
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'edit', { file: 'a.txt' }),
    toolCallResponse('c2', 'bash', { command: 'npm test' }),
    textResponse('Done anyway.'),
    // The forced continuation edits again and still does not verify.
    toolCallResponse('c3', 'edit', { file: 'b.txt' }),
    textResponse('Still done anyway.'),
  ])
  const ctx = await harness(adapter)
  registerTools(ctx, { shellExit: 1 })
  const agent = await ctx.agentLoop.create(SessionId('e2e-3'), { provider: 'mock', model: 'mock' })
  await send(agent, 'change files')
  await waitForIdle(ctx, agent)

  assert.equal(steerMessages(agent).length, 1, 'only one forced continuation even though the second stop was also unverified')
  assert.equal(adapter.requests.length, 5, `requests: ${adapter.requests.length}`)
  // The cap path, not a coincidence: the first stop's steer is the only one in
  // the log, and the second stop produced no new message — the guard reached its
  // counter and declined rather than never being asked.
  const userMessages = agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message')
  // turn/end's reason is `completed`, which is what a clean stop looks like; a
  // cancelled turn would read `cancelled`.
  assert.equal(userMessages.filter(event => event.data.source.kind === Guard.STEER_SOURCE).length, 1)
  assert.equal(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
})

// ── 4 · a read-only turn is not treated as work that needs verifying ──────────
await scenario('a turn with no file changes is never steered', async () => {
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'bash', { command: 'ls' }),
    textResponse('Listed.'),
  ])
  const ctx = await harness(adapter)
  registerTools(ctx, { shellExit: 0 })
  const agent = await ctx.agentLoop.create(SessionId('e2e-4'), { provider: 'mock', model: 'mock' })
  await send(agent, 'look around')
  await waitForIdle(ctx, agent)

  assert.equal(steerMessages(agent).length, 0)
  assert.equal(adapter.requests.length, 2, `requests: ${adapter.requests.length}`)
})

process.stdout.write(`\ne2e-guard: ${failures.length === 0 ? `ALL PASS (${passed})` : `${failures.length} FAILURE(S)`}\n`)
if (failures.length > 0) process.exitCode = 1
