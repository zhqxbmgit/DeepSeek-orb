/**
 * Which model the background track uses while the user has not picked one.
 *
 * The product owns that default: `agentDefaultModel.currentSelection()` is what a new Agent is
 * created with, and the account sign-in flow rewrites it to the account route when no provider
 * API key is configured. The background Agent follows it, so an account-only user is never
 * left on the API-key route. Picking a model in settings pins that track; a track the user
 * never touched keeps following.
 *
 * `refreshModelFallback` is called once by the plugin entry, so the value the settings page
 * shows is the value a new background session would use.
 */

import { normalizeCatalog, type CatalogGroup, type ModelCatalog } from './catalog.ts'
import { DEFAULT_MODEL, sameSelection, type AgentModelSelection } from './preferences.ts'

/** Host services the fallback is read from. */
export interface ModelDefaultSource {
  readonly sessionController: { modelCatalog(): unknown }
  readonly agentDefaultModel?: { currentSelection(): AgentModelSelection } | undefined
}

/** The store half this module writes: the memory-only fallback for the unpicked tracks. */
export interface ModelFallbackStore {
  applyModelFallback(selection: AgentModelSelection): boolean
}

/** True when the live catalog advertises this exact provider and model. */
export function catalogAdvertises(groups: readonly CatalogGroup[], selection: AgentModelSelection): boolean {
  return groups.some((group) => group.id === selection.provider
    && group.models.some((model) => model.id === selection.model))
}

/**
 * The selection both tracks follow until the user pins one.
 *
 * The product default comes first even though the shipped pair is usually advertised too: the
 * API-key route publishes its catalog without looking at credentials, so "is it advertised"
 * alone would keep an account-only user on the route that cannot authenticate. The shipped pair
 * is the fallback for a deployment whose catalog or product default predates the account
 * provider; the first advertised model is the last resort before the shipped pair.
 */
export function fallbackSelection(
  groups: readonly CatalogGroup[],
  product: AgentModelSelection | undefined,
): AgentModelSelection {
  if (product !== undefined && catalogAdvertises(groups, product)) return product
  if (catalogAdvertises(groups, DEFAULT_MODEL)) return DEFAULT_MODEL
  return firstAdvertised(groups) ?? DEFAULT_MODEL
}

/** The product's default model, or undefined when the service is missing or unusable. */
export function readProductDefault(source: ModelDefaultSource): AgentModelSelection | undefined {
  let selection: AgentModelSelection | undefined
  try {
    selection = source.agentDefaultModel?.currentSelection()
  } catch {
    // A config-editor write can leave the reference mid-update; the shipped pair covers the read.
    return undefined
  }
  if (selection === undefined) return undefined
  if (typeof selection.provider !== 'string' || selection.provider === '') return undefined
  if (typeof selection.model !== 'string' || selection.model === '') return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
      ? { reasoningEffort: selection.reasoningEffort }
      : {},
  }
}

export interface ModelFallbackResult {
  readonly catalog: ModelCatalog
  /** True when the fallback itself moved, which is what makes a live session re-select. */
  readonly changed: boolean
}

/**
 * Read the live catalog and the product default, then adopt the fallback on the store.
 * `changed` never reports an explicit pick: only the value the unpicked tracks follow.
 */
export async function refreshModelFallback(
  source: ModelDefaultSource,
  store: ModelFallbackStore,
): Promise<ModelFallbackResult> {
  const catalog = normalizeCatalog(await source.sessionController.modelCatalog())
  const changed = store.applyModelFallback(fallbackSelection(catalog.groups, readProductDefault(source)))
  return { catalog, changed }
}

/** First advertised model, carrying the effort its catalog entry defaults to. */
function firstAdvertised(groups: readonly CatalogGroup[]): AgentModelSelection | undefined {
  const group = groups[0]
  const model = group?.models[0]
  if (group === undefined || model === undefined) return undefined
  const defaultEffort = model.reasoning?.defaultEffort
  return {
    provider: group.id,
    model: model.id,
    ...defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort },
  }
}

/** Re-exported so callers comparing the product default do not reach into the profile module. */
export { sameSelection }
