import { render, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'

// The mermaid plugin is imported after mount instead of at module scope, so a
// plain unit test has to prove the diagram still renders. jsdom also lacks the
// IntersectionObserver that streamdown uses to defer off-screen diagrams.
class ImmediateIntersectionObserver {
  private cb: (entries: unknown[]) => void
  constructor(cb: (entries: unknown[]) => void) {
    this.cb = cb
  }
  takeRecords() {
    return []
  }
  observe(target: Element) {
    this.cb([{ isIntersecting: true, target }])
  }
  unobserve() {}
  disconnect() {}
}

vi.mock('@streamdown/mermaid', () => ({
  mermaid: {
    getMermaid: () => ({
      render: async () => ({ svg: '<svg data-testid="mermaid-diagram"></svg>' }),
    }),
  },
}))

// 图表渲染链路是「idle 回调 → 动态导入插件 → 异步 render」，并行跑全量时这条链
// 不保证落在 waitFor 默认的 1 秒里；给一个和测试超时同量级的预算，别把机器负载
// 当成回归。
const DIAGRAM_WAIT = { timeout: 15000 }

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.IntersectionObserver = ImmediateIntersectionObserver
  g.requestIdleCallback = (cb: (d: unknown) => void) =>
    setTimeout(() => cb({ timeRemaining: () => 10, didTimeout: false }), 0)
  g.cancelIdleCallback = clearTimeout
})

describe('RenderMarkdown mermaid', () => {
  it.each([false, true])('renders a fence with whitespace before its language (streaming=%s)', async isStreaming => {
    const view = render(<RenderMarkdown content={'``` \tmermaid\ngraph TD;\nA-->B;\n```\n\nBody'} isStreaming={isStreaming} />)
    await waitFor(
      () => expect(view.container.querySelector('[data-testid="mermaid-diagram"]')).toBeTruthy(),
      DIAGRAM_WAIT
    )
  })

  it('renders a diagram through the plugin loaded after mount', async () => {
    render(<RenderMarkdown content={'```mermaid\ngraph TD;\nA-->B;\n```'} />)
    await waitFor(
      () => expect(document.querySelector('[data-testid="mermaid-diagram"]')).toBeTruthy(),
      DIAGRAM_WAIT
    )
  })

  it('renders a closed diagram while the next paragraph is still streaming', async () => {
    const view = render(<RenderMarkdown content={'```mermaid\ngraph TD;\nA-->B;\n```\n\nNext paragraph'} isStreaming />)
    await waitFor(
      () => expect(view.container.querySelector('[data-testid="mermaid-diagram"]')).toBeTruthy(),
      DIAGRAM_WAIT
    )
  })
})
