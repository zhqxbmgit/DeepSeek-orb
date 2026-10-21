/**
 * Host-side plugin for the main-window Computer Use build.
 *
 * The only floating UI is the observation ribbon: a minimal helper process
 * that draws it and acks overlay intervals. There is no ball, chat, session,
 * question, avatar, workspace, history, or update runtime here.
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createOverlayGuard } from './overlay-guard.ts'
import { OverlayRuntime } from './overlay-runtime.ts'
import { ownPackage } from './package-info.ts'
import { profileDirectory, ProfileStore } from './preferences.ts'
import { registerOrbRoutes } from './routes.ts'
import { installOrbServices } from './services.ts'
import { refreshModelFallback } from './model-defaults.ts'
import { KOFFI_DIR_ENV, ownPackageRoot, removeStaleStages, stageKoffi } from './native-images.ts'
import { TccMonitor } from './tcc.ts'

/** Cordis plugin name. */
export const name = 'orb-host'

/** Official services this plugin reads. Missing ones keep it pending. */
export const inject = ['webServer', 'connection', 'sessionController', 'agentDefaultModel']

/** Host services the plugin injects. Shapes match the official 0.1.7-rc.2 controllers. */
export interface OrbContext {
  readonly webServer: {
    readonly port: number
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
    }): () => void
  }
  readonly connection: {
    authenticatedUrl(baseUrl: string): string
    admit?(request: import('node:http').IncomingMessage): { rejection?: number } | { peer?: unknown }
    isAuthenticated?(request: import('node:http').IncomingMessage): boolean
  }
  readonly sessionController: {
    modelCatalog(): unknown
  }
  readonly agentDefaultModel?: {
    currentSelection(): {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }
  }
  effect(execute: () => void | (() => void)): void
  get(name: string): unknown
  provide(name: string, value: unknown): void
}

export type { OrbContext as HostContext }

/**
 * Register preferences, the observation-ribbon runtime, Computer Use services,
 * and settings routes.
 * @param ctx - host services named in {@link inject}.
 */
export function apply(ctx: OrbContext): void {
  logWebPort(ctx)
  const own = ownPackage()
  const profile = profileDirectory(ctx)
  if (process.platform === 'win32' && own !== undefined) {
    // Before anything loads koffi: a loaded addon inside the package locks it against
    // a later local package replacement on Windows (see native-images.ts).
    stageNativeImages()
  }
  const store = new ProfileStore(profile)
  const tcc = new TccMonitor()
  const runtime = new OverlayRuntime(store, store.dir)
  const guard = createOverlayGuard({
    hasHelper: () => runtime.hasHelper(),
    send: (message, signal) => runtime.send(message, signal),
    setHidInput: () => {
      // The ribbon is click-through at rest; no per-input focus change is needed.
    },
    chromeWindowIds: () => runtime.chromeWindowIds(),
    observationFrameEnabled: () => store.observationFrameEnabled(),
  })
  ctx.provide('computerUseOverlayGuard', guard)
  installOrbServices(ctx, store)
  void refreshModelFallback(ctx, store).catch((error: unknown) => {
    console.error(`dsh-orb: model fallback failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  console.error(`dsh-orb: profile ${store.dir}`)
  console.error(`dsh-orb: version ${own?.version ?? 'unknown'}`)
  ctx.effect(() => {
    const detachRoutes = registerOrbRoutes({ ctx, store, tcc, runtime })
    if (process.platform !== 'linux' && store.observationFrameEnabled()) {
      void runtime.start().catch((error: unknown) => {
        console.error(`dsh-orb: ribbon start failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return () => {
      detachRoutes()
      runtime.stop()
    }
  })
}

/**
 * Point every koffi loader at a copy outside the package and clear what failed updates left.
 */
function stageNativeImages(): void {
  const root = ownPackageRoot()
  try {
    const dir = stageKoffi(root, dshHomePath('dsh-orb', 'native'))
    if (dir !== undefined) process.env[KOFFI_DIR_ENV] = dir
  } catch (error) {
    console.error(`dsh-orb: koffi stays in the package: ${error instanceof Error ? error.message : String(error)}`)
  }
  removeStaleStages(root)
}

/** Print the loopback port. The authenticated URL contains credentials, so it is never logged. */
function logWebPort(ctx: OrbContext): void {
  const port = ctx.webServer.port
  try {
    const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`)
    const hostname = new URL(authed).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      console.error('dsh-orb: authenticated URL is not loopback')
    }
  } catch {
    console.error('dsh-orb: authenticated URL is unavailable')
  }
  console.error(`dsh-orb: host web port ${port}`)
}
