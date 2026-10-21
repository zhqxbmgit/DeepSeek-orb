import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

function trivial(name: string) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute: () => Promise.resolve({}),
  })
}

const contexts: Context[] = []

/** Model-facing text of one tool outcome. */
function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/**
 * Why ownership rides an execution guard plus a prompt section instead of a tool restriction.
 *
 * `tools.restrict()` filters what a scope INHERITS — the global layer and its ancestors — and never
 * what the scope registers itself. The GUI tools are registered inside the agent's own scope (that
 * is what keeps them out of the host catalog), so their names are not restrictable from that scope
 * at all: the call throws. A restriction from an ancestor cannot reach them either, because the
 * scope's own layer wins the name. That leaves the monotonic guard, which is what
 * a host can use when it needs execution-time ownership checks.
 */
describe('desktop ownership mechanism', () => {
  it('cannot hide the GUI tools with a restriction, but a scoped guard does decide per agent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    // Global registration, like the app-level shell plugin.
    ctx.tools.register(trivial('bash'))

    const agent = { id: 'session-a' } as unknown as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
      inject: ['tools'],
    }))
    // Scoped registration, like the preset's own GUI tools.
    scope.ctx.tools.register(trivial('click'))

    // An inherited global tool IS restrictable; a tool the scope owns is not.
    const inherited = scope.ctx.tools.restrict({ deny: ['bash'] })
    expect(() => scope.ctx.tools.restrict({ deny: ['click'] })).toThrow(/unknown global tool "click"/)
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['click'])
    inherited()

    // A guard registered through the agent's scope carries that agent's identity. Scope layers are
    // keyed by the identity handed to `createScope`, so the execution must carry that same handle.
    scope.ctx.tools.guard(execution => (
      execution.agent === agent ? 'denied for the background session' : undefined
    ))
    const call = (handle: Agent) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'ownership-probe' as never,
      name: 'click',
      arguments: {},
      agent: handle,
    })
    // A denial materializes as an isError result, which is what reaches the model as the tool result.
    const denied = await call(agent)
    expect(text(denied)).toBe('Error: denied for the background session')
  })
})
