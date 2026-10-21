/**
 * Settings routes on the official web port.
 * The main window calls these with a relative fetch, so the existing login
 * cookie is enough. There is no helper-authenticated HTTP route: the frame
 * helper talks only to the loopback control socket.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeCatalog, type ModelCatalog } from './catalog.ts'
import type { FrameStatus, OverlayRuntime } from './overlay-runtime.ts'
import { isAgentModelSelection, type AgentModelSelection, type ProfileStore } from './preferences.ts'
import { isTccRight, type TccMonitor, type TccStatus } from './tcc.ts'
import { ownPackage } from './package-info.ts'

const PREFIX = '/.dsh-orb'

interface RouteContext {
  readonly webServer: {
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }): () => void
  }
  readonly connection: {
    admit?(request: IncomingMessage): { rejection?: number } | { peer?: unknown }
    isAuthenticated?(request: IncomingMessage): boolean
  }
  readonly sessionController: {
    modelCatalog(): unknown
  }
}

interface RouteDeps {
  readonly ctx: RouteContext
  readonly store: ProfileStore
  readonly tcc: TccMonitor
  readonly runtime: OverlayRuntime
}

/** Mount `/.dsh-orb` and return the disposer. */
export function registerOrbRoutes(deps: RouteDeps): () => void {
  return deps.ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => handle(deps, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      const status = errorStatus(error) ?? 500
      if (status === 500) {
        console.error(`dsh-orb: route failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      sendJson(res, status, { error: status === 500 ? 'internal-error' : errorMessage(error) })
    }),
  })
}

export function orbSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

async function handle(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rejection = rejectionStatus(deps.ctx, req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'
  if (method === 'GET' && path === `${PREFIX}/settings`) {
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'GET' && path === `${PREFIX}/models`) {
    sendJson(res, 200, await catalog(deps))
    return
  }
  if (method === 'GET' && path === `${PREFIX}/tcc`) {
    sendJson(res, 200, deps.tcc.status())
    return
  }
  if (!orbSupported()) {
    sendJson(res, 403, { error: 'unsupported' })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/background-model`) {
    const selection = selectionFrom(await readJson(req))
    if (selection === undefined) {
      sendJson(res, 400, { error: 'invalid-model' })
      return
    }
    deps.store.setBackground(selection)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/millifraction`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-millifraction' })
      return
    }
    deps.store.setMillifractionEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/observation-frame`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-observation-frame' })
      return
    }
    deps.store.setObservationFrameEnabled(enabled)
    if (enabled) {
      void deps.runtime.start().catch((error: unknown) => {
        console.error(`dsh-orb: ribbon start failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } else {
      void deps.runtime.setObservationFrame(null).catch(() => {
        // The helper may already be gone; hiding is best-effort before it stops.
      })
      deps.runtime.stop()
    }
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/frame/restart`) {
    deps.store.setObservationFrameEnabled(true)
    void deps.runtime.restart().catch((error: unknown) => {
      console.error(`dsh-orb: ribbon restart failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/tcc`) {
    const right = asRecord(await readJson(req))?.right
    if (!isTccRight(right)) {
      sendJson(res, 400, { error: 'invalid-tcc' })
      return
    }
    await deps.tcc.open(right)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  res.writeHead(404)
  res.end()
}

export interface SettingsSnapshot {
  readonly supported: boolean
  readonly version: string
  readonly background: AgentModelSelection
  readonly millifractionEnabled: boolean
  readonly observationFrameEnabled: boolean
  readonly frame: FrameStatus
  readonly tcc: TccStatus
}

async function snapshot(deps: RouteDeps): Promise<SettingsSnapshot> {
  return {
    supported: orbSupported(),
    version: ownPackage()?.version ?? '',
    background: deps.store.backgroundModel(),
    millifractionEnabled: deps.store.millifractionEnabled(),
    observationFrameEnabled: deps.store.observationFrameEnabled(),
    frame: deps.runtime.status(),
    tcc: deps.tcc.status(),
  }
}

async function catalog(deps: RouteDeps): Promise<ModelCatalog> {
  try {
    return normalizeCatalog(await deps.ctx.sessionController.modelCatalog())
  } catch (error) {
    console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`)
    return { groups: [] }
  }
}

function rejectionStatus(ctx: RouteContext, req: IncomingMessage): number | undefined {
  if (typeof ctx.connection.admit === 'function') {
    const admitted = ctx.connection.admit(req)
    if (typeof admitted === 'object' && admitted !== null && 'rejection' in admitted && typeof admitted.rejection === 'number') {
      return admitted.rejection
    }
    return undefined
  }
  if (typeof ctx.connection.isAuthenticated === 'function') {
    return ctx.connection.isAuthenticated(req) ? undefined : 401
  }
  return 401
}

function selectionFrom(value: unknown): AgentModelSelection | undefined {
  return isAgentModelSelection(value) ? value : undefined
}

function booleanField(value: unknown): boolean | undefined {
  const enabled = asRecord(value)?.enabled
  return typeof enabled === 'boolean' ? enabled : undefined
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' && status >= 400 && status < 600 ? status : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'request-failed'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBody(req, 64 * 1024)
  if (bytes.length === 0) return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw Object.assign(new Error('invalid-json'), { status: 400 })
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('too-large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
