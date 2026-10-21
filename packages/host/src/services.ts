/**
 * The two optional services Computer Use reads from this Host.
 * Model and coordinate choices stay Host-owned; the main-window Agent keeps
 * its own official session and permission configuration.
 */

import type { ProfileStore } from './preferences.ts'

interface ServiceContext {
  provide(name: string, value: unknown): void
}

/**
 * Publish the background-model and coordinate-mode services for the life of
 * the plugin.
 * @param ctx - host context. `provide` is called once.
 * @param store - profile preferences.
 */
export function installOrbServices(ctx: ServiceContext, store: ProfileStore): void {
  ctx.provide('orbCodeAgentModel', {
    currentSelection: () => store.backgroundModel(),
  })
  ctx.provide('orbCoordinateMode', {
    currentMode: () => store.coordinateMode(),
  })
}
