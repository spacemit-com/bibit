import { describe, expect, it } from 'vitest'
import {
  groupFeatureSettingsNavigation,
  mergeFeatureNavigation,
  mergeFeatureSettingsNavigation,
} from '../navigation'

const item = (id: string, group: string, order = 1) => ({
  id,
  group,
  order,
  title: id,
  path: `/features/${id}`,
  iconKey: id,
})

describe('navigation groups this build does not know', () => {
  it('orders an unknown page group after the known ones instead of dropping it', () => {
    const merged = mergeFeatureNavigation([
      item('future', 'future-surface'),
      item('store', 'workspace'),
    ])

    expect(merged.map(({ id }) => id)).toEqual(['store', 'future'])
  })

  it('keeps an unknown settings group reachable in the features bucket', () => {
    const grouped = groupFeatureSettingsNavigation(
      mergeFeatureSettingsNavigation([
        item('diagnostics', 'troubleshooting'),
        item('memory', 'privacy'),
      ])
    )

    expect(grouped.features.map(({ id }) => id)).toEqual(['diagnostics'])
    expect(grouped.privacy.map(({ id }) => id)).toEqual(['memory'])
    expect(grouped.core).toEqual([])
    expect(grouped.integrations).toEqual([])
  })

  it('sorts a mix of known and unknown groups by rank before order', () => {
    const merged = mergeFeatureNavigation([
      item('unknown-b', 'zzz', 1),
      item('known-late', 'tools', 1),
      item('unknown-a', 'aaa', 2),
      item('known-early', 'workspace', 2),
    ])

    expect(merged.map(({ id }) => id)).toEqual([
      'known-early',
      'known-late',
      'unknown-b',
      'unknown-a',
    ])
  })
})
