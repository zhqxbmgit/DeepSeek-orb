import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as Registry from '../src/code-agent-registry.ts'

/**
 * Mounting the registry row the way `cordis.patch.yml` does.
 *
 * The unit test next to the registry calls `apply` on a hand-written fake context, which cannot see
 * cordis's own rule that a service is unreadable from a context that did not inject it. These tests
 * mount the real plugin in a real context so the seam cannot be lost again.
 */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function appContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('registry row mounting', () => {
  it('provides the registry service in a real context', async () => {
    const ctx = await appContext()
    await ctx.plugin(Registry)
    expect(ctx.get(Registry.CODE_AGENT_REGISTRY)).toBe(Registry.sharedCodeAgentRegistry())
  })

  it('mounts beside a tools runtime without depending on it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Registry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    expect(ctx.get(Registry.CODE_AGENT_REGISTRY)).toBe(Registry.sharedCodeAgentRegistry())
  })
})
