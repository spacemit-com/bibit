import type {
  FeatureSurface,
  FeatureTarget,
} from '@bibit/feature-contracts'
import type { FeatureRegistrySourceEntry } from './host/registry'

export type FeatureRegistryRejection =
  | {
      readonly code: 'duplicate-feature-id'
      readonly featureId: string
      readonly packageName: string
      readonly reason: string
    }
  | {
      readonly code: 'permission-presenter-conflict'
      readonly featureId: string
      readonly packageName: string
      readonly target: FeatureTarget
      readonly surface: FeatureSurface
      readonly conflictsWith: readonly string[]
      readonly reason: string
    }

export interface FeatureRegistryMergeResult<
  Entry extends FeatureRegistrySourceEntry,
> {
  readonly entries: readonly Entry[]
  readonly rejections: readonly FeatureRegistryRejection[]
}

type PresenterSlot = {
  readonly target: FeatureTarget
  readonly surface: FeatureSurface
}

const slotKey = ({ target, surface }: PresenterSlot) =>
  `${target}\u0000${surface}`

const presenterSlots = (
  entry: FeatureRegistrySourceEntry
): readonly PresenterSlot[] =>
  entry.manifest.contributions.conversation
    .filter(({ kind }) => kind === 'permission-presenter')
    .flatMap((contribution) =>
      entry.manifest.targets.flatMap((target) =>
        contribution.surfaces.map((surface) => ({ target, surface }))
      )
    )

const stableRejections = (
  rejections: readonly FeatureRegistryRejection[]
) =>
  Object.freeze(
    [...rejections].sort((left, right) =>
      [left.featureId, left.packageName, left.code]
        .join('\u0000')
        .localeCompare(
          [right.featureId, right.packageName, right.code].join('\u0000')
        )
    )
  )

export const mergeFeatureRegistryEntries = <
  Entry extends FeatureRegistrySourceEntry,
>(
  staticEntries: readonly Entry[],
  runtimeEntries: readonly Entry[]
): FeatureRegistryMergeResult<Entry> => {
  const staticIds = new Set(staticEntries.map(({ manifest }) => manifest.id))
  const runtimeById = new Map<string, Entry[]>()
  for (const entry of runtimeEntries) {
    const group = runtimeById.get(entry.manifest.id) ?? []
    group.push(entry)
    runtimeById.set(entry.manifest.id, group)
  }

  const rejectedEntries = new Set<Entry>()
  const rejections: FeatureRegistryRejection[] = []
  for (const [featureId, group] of runtimeById) {
    if (!staticIds.has(featureId) && group.length === 1) continue
    const reason = staticIds.has(featureId)
      ? `duplicate Feature id ${featureId} conflicts with a static Feature`
      : `duplicate Feature id ${featureId} appears in multiple runtime entries`
    for (const entry of group) {
      rejectedEntries.add(entry)
      rejections.push({
        code: 'duplicate-feature-id',
        featureId,
        packageName: entry.packageName,
        reason,
      })
    }
  }

  const staticPresenters = new Map<string, string[]>()
  for (const entry of staticEntries) {
    for (const slot of presenterSlots(entry)) {
      const key = slotKey(slot)
      const featureIds = staticPresenters.get(key) ?? []
      featureIds.push(entry.manifest.id)
      staticPresenters.set(key, featureIds)
    }
  }

  const runtimePresenterClaims = new Map<
    string,
    { readonly slot: PresenterSlot; readonly entries: Entry[] }
  >()
  for (const entry of runtimeEntries) {
    if (rejectedEntries.has(entry)) continue
    const slots = [...presenterSlots(entry)].sort((left, right) =>
      slotKey(left).localeCompare(slotKey(right))
    )
    const conflict = slots
      .map((slot) => ({ slot, featureIds: staticPresenters.get(slotKey(slot)) }))
      .find(
        (
          value
        ): value is { readonly slot: PresenterSlot; readonly featureIds: string[] } =>
          value.featureIds !== undefined
      )
    if (conflict) {
      const conflictsWith = Object.freeze([...new Set(conflict.featureIds)].sort())
      rejectedEntries.add(entry)
      rejections.push({
        code: 'permission-presenter-conflict',
        featureId: entry.manifest.id,
        packageName: entry.packageName,
        ...conflict.slot,
        conflictsWith,
        reason: `permission-presenter conflict on ${conflict.slot.target}/${conflict.slot.surface} with static Feature ${conflictsWith.join(', ')}`,
      })
      continue
    }
    for (const slot of slots) {
      const key = slotKey(slot)
      const claim = runtimePresenterClaims.get(key) ?? { slot, entries: [] }
      claim.entries.push(entry)
      runtimePresenterClaims.set(key, claim)
    }
  }

  const runtimeConflicts = new Map<Entry, FeatureRegistryRejection>()
  const claims = [...runtimePresenterClaims.values()].sort((left, right) =>
    slotKey(left.slot).localeCompare(slotKey(right.slot))
  )
  for (const { slot, entries } of claims) {
    if (entries.length < 2) continue
    const conflictsWith = Object.freeze(
      [...new Set(entries.map(({ manifest }) => manifest.id))].sort()
    )
    for (const entry of entries) {
      if (runtimeConflicts.has(entry)) continue
      runtimeConflicts.set(entry, {
        code: 'permission-presenter-conflict',
        featureId: entry.manifest.id,
        packageName: entry.packageName,
        ...slot,
        conflictsWith,
        reason: `permission-presenter conflict on ${slot.target}/${slot.surface} among runtime Features ${conflictsWith.join(', ')}`,
      })
    }
  }
  for (const [entry, rejection] of runtimeConflicts) {
    rejectedEntries.add(entry)
    rejections.push(rejection)
  }

  return Object.freeze({
    entries: Object.freeze([
      ...staticEntries,
      ...runtimeEntries.filter((entry) => !rejectedEntries.has(entry)),
    ]),
    rejections: stableRejections(rejections),
  })
}
