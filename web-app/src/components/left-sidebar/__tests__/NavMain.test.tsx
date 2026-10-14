/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import {
  buildFeatureNavMainItems,
  mergeFeatureNavigation,
} from '@/features/navigation'

const h = vi.hoisted(() => ({ ready: [] as Array<() => void> }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: any) => <a href={to}>{children}</a>,
  useNavigate: () => () => {},
}))
vi.mock('@tauri-apps/api/event', () => ({
  once: async (_event: string, handler: () => void) => {
    h.ready.push(handler)
    return () => {}
  },
}))

import { NavMain } from '../NavMain'
import { SidebarProvider } from '@/components/ui/sidebar'

describe('NavMain animated icons', () => {
  it('uses the static icon first and swaps in the animated one after app-ready', async () => {
    h.ready.length = 0
    const { container } = render(
      <SidebarProvider>
        <NavMain />
      </SidebarProvider>
    )

    // 静态图标是 lucide 的 <svg>；动画图标多一层 <div> 包着 svg。
    expect(container.querySelectorAll('svg.lucide').length).toBe(3)
    expect(container.querySelectorAll('div > svg').length).toBe(0)

    await waitFor(() => expect(h.ready).toHaveLength(1))
    await act(async () => {
      h.ready.forEach((fire) => fire())
    })

    // 这一帧要等动画图标那段懒加载 chunk（motion，约 259 个模块）到手；并行跑全量
    // 时冷加载不保证落在 waitFor 默认的 1 秒里，给一个和测试超时同量级的预算，
    // 免得把机器负载当成回归。
    await waitFor(
      () => expect(container.querySelectorAll('div > svg').length).toBe(3),
      { timeout: 15000 }
    )
    expect(container.querySelectorAll('svg.lucide').length).toBe(0)
  })
})

describe('Feature main navigation merge', () => {
  it('includes only declared navigation and sorts by group/order/id', () => {
    const result = mergeFeatureNavigation([
      { id: 'z', group: 'tools', order: 2, title: 'Store', path: '/features/z', iconKey: 'store' },
      { id: 'hidden', title: 'Hidden', path: '/features/hidden', iconKey: 'feature' },
      { id: 'a', group: 'library', order: 1, title: 'Memory', path: '/features/a', iconKey: 'memory' },
    ])
    expect(result.map((item) => item.id)).toEqual(['a', 'z'])
  })

  it('defaults order to 1000 and breaks ties by full contribution id', () => {
    const result = mergeFeatureNavigation([
      {
        id: 'z-feature:page',
        group: 'tools',
        title: 'Aardvark',
        path: '/features/z-feature',
        iconKey: 'feature',
      },
      {
        id: 'a-feature:page',
        group: 'tools',
        title: 'Zulu',
        path: '/features/a-feature',
        iconKey: 'feature',
      },
      {
        id: 'm-feature:page',
        group: 'tools',
        order: 999,
        title: 'Middle',
        path: '/features/m-feature',
        iconKey: 'feature',
      },
    ])

    expect(result.map((item) => item.id)).toEqual([
      'm-feature:page',
      'a-feature:page',
      'z-feature:page',
    ])
  })

  it('uses stable contribution identities without translating twice', () => {
    const translate = vi.fn((key: string) => `${key}-translated`)
    const items = buildFeatureNavMainItems(
      mergeFeatureNavigation([
        { id: 'second', group: 'tools', title: 'Same', titleKey: 'feature:second', path: '/features/second', iconKey: 'feature' },
        { id: 'first', group: 'tools', title: 'Same', titleKey: 'feature:first', path: '/features/first', iconKey: 'feature' },
        { id: 'unicode', group: 'tools', title: 'ä', path: '/features/unicode', iconKey: 'feature' },
        { id: 'ascii', group: 'tools', title: 'z', path: '/features/ascii', iconKey: 'feature' },
      ]),
      translate
    )
    expect(items.map((item) => item.id)).toEqual([
      'ascii',
      'first',
      'second',
      'unicode',
    ])
    expect(items.slice(1, 3).map((item) => item.url)).toEqual([
      '/features/first',
      '/features/second',
    ])
    expect(translate).toHaveBeenCalledTimes(2)
  })
})
