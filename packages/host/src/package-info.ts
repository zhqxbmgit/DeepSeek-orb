/** The installed package manifest, used for the settings version line and logs. */

import { readFileSync } from 'node:fs'

export interface OwnPackage {
  readonly name: string
  readonly version: string
}

/**
 * Read the installed manifest.
 * The assembled layout puts `dist/host/index.js` beside the package's
 * `package.json`; a source checkout finds no manifest there, so callers treat
 * an unknown version as "not installed".
 * @param url - module URL to resolve the package root from.
 * @returns name and version, or undefined when no usable manifest is beside it.
 */
export function ownPackage(url: string = import.meta.url): OwnPackage | undefined {
  let raw: string
  try {
    raw = readFileSync(new URL('../../package.json', url), 'utf8')
  } catch {
    return undefined
  }
  try {
    const manifest = JSON.parse(raw) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined
    if (manifest.name === '' || manifest.version === '') return undefined
    return { name: manifest.name, version: manifest.version }
  } catch {
    return undefined
  }
}
