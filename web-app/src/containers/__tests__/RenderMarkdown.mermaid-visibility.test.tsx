import { act, render, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'

/**
 * Streamdown 用 IntersectionObserver 推迟离屏图表的渲染。线上"追加一条消息后图表
 * 变空容器、滚回视野又有图"就是这条机制的表现，本文件把它的三条不变量固定下来：
 *   1. 未进入视口：容器在，SVG 不渲染；
 *   2. 进入视口：SVG 渲染；
 *   3. 之后追加别的消息：已渲染的 SVG 不能被清掉。
 */

type IntersectionCb = (entries: unknown[]) => void

const observedTargets: Element[] = []
let lastCallback: IntersectionCb | null = null

class ControllableIntersectionObserver {
  private targets: Element[] = []
  constructor(private cb: IntersectionCb) {
    lastCallback = cb
  }
  observe(target: Element) {
    this.targets.push(target)
    observedTargets.push(target)
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
  enter() {
    this.cb(this.targets.map(target => ({ isIntersecting: true, target })))
  }
}

const renderCalls: string[] = []

vi.mock('@streamdown/mermaid', () => ({
  mermaid: {
    getMermaid: () => ({
      render: async (_id: string, chart: string) => {
        renderCalls.push(chart)
        return { svg: '<svg data-testid="mermaid-diagram"></svg>' }
      },
    }),
  },
}))

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.IntersectionObserver = ControllableIntersectionObserver
  g.requestIdleCallback = (cb: (d: unknown) => void) =>
    setTimeout(() => cb({ timeRemaining: () => 10, didTimeout: false }), 0)
  g.cancelIdleCallback = clearTimeout
})

const CORE = '```mermaid\ngraph LR\n A[事件] --> B[提交]\n```\n\n富内容结束\n'
const FOLLOW_UP = '短回答\n'

function Thread({ items }: { items: { id: string; content: string }[] }) {
  return (
    <div>
      {items.map(item => (
        <RenderMarkdown key={item.id} messageId={item.id} content={item.content} />
      ))}
    </div>
  )
}

const diagrams = () => document.querySelectorAll('[data-testid="mermaid-diagram"]')

describe('RenderMarkdown mermaid 可见性', () => {
  it('离屏不渲染、进入视口才渲染，且追加消息后不会被清掉', async () => {
    renderCalls.length = 0
    observedTargets.length = 0

    const view = render(<Thread items={[{ id: 'm1', content: CORE }]} />)

    // 图表块本身要挂上去等待观察；此时还没进入视口，所以不该有 SVG。
    await waitFor(() => expect(observedTargets.length).toBeGreaterThan(0))
    expect(diagrams()).toHaveLength(0)
    expect(renderCalls).toHaveLength(0)

    // 进入视口：渲染出 SVG。
    await act(async () => {
      lastCallback?.([{ isIntersecting: true, target: observedTargets[0] }])
    })
    await waitFor(() => expect(diagrams()).toHaveLength(1))
    expect(renderCalls).toHaveLength(1)

    // 追加一条消息（模拟会话列表重新渲染）：已渲染的图表必须还在。
    view.rerender(
      <Thread
        items={[
          { id: 'm1', content: CORE },
          { id: 'm2', content: FOLLOW_UP },
        ]}
      />
    )
    await waitFor(() => expect(view.container.textContent).toContain('短回答'))
    expect(diagrams()).toHaveLength(1)

    // 再追加一条，仍然不能被清掉，也不能重复渲染成两张图。
    view.rerender(
      <Thread
        items={[
          { id: 'm1', content: CORE },
          { id: 'm2', content: FOLLOW_UP },
          { id: 'm3', content: FOLLOW_UP },
        ]}
      />
    )
    await waitFor(() => expect(view.container.textContent).toContain('短回答'))
    expect(diagrams()).toHaveLength(1)
  })
})
