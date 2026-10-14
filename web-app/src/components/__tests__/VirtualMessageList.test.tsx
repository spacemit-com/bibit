import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import '@testing-library/jest-dom'
import { VirtualMessageList } from '../ai-elements/virtual-message-list'

const ROW_HEIGHT = 180
const VIEWPORT_HEIGHT = 800

// jsdom 没有任何布局：视口和行高都得自己给，否则虚拟化算出的可见区间是空的。
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        width: 800,
        height: ROW_HEIGHT,
        top: 0,
        left: 0,
        right: 800,
        bottom: ROW_HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
  )
})

const scroller = () => {
  const element = document.createElement('div')
  Object.defineProperty(element, 'offsetHeight', { value: VIEWPORT_HEIGHT })
  return element
}
const renderRow = (index: number) => <span>{`row-${index}`}</span>

// 与 StickToBottom 同构：容器在父级 layout effect 里才交给子级。
const ScrollerHolder = ({
  children,
}: {
  children: (context: { current: HTMLDivElement | null }) => ReactNode
}) => {
  const holder = useRef<HTMLDivElement | null>(null)
  const context = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    context.current = holder.current
  }, [])
  return (
    <div
      ref={node => {
        if (node) Object.defineProperty(node, 'offsetHeight', { value: VIEWPORT_HEIGHT })
        holder.current = node
      }}
    >
      {children(context)}
    </div>
  )
}

describe('会话消息行虚拟化', () => {
  it('条数低于阈值时按原样全部渲染', () => {
    const { container } = render(
      <VirtualMessageList
        count={3}
        getKey={index => `key-${index}`}
        getScrollElement={scroller}
        renderRow={renderRow}
      />
    )
    expect(container.querySelectorAll('span')).toHaveLength(3)
    // 不虚拟化时不引入任何额外的定位层。
    expect(container.querySelector('[data-index]')).toBeNull()
  })

  it('滚动容器由外层持有、commit 后才交付时，仍能挂载行', () => {
    // 真实结构：滚动容器是消息列表的**祖先**，由 StickToBottom 通过 ref 在它自己的
    // layout effect 里交付 —— 那一刻子级的 layout effect 已经跑完。
    const { container } = render(
      <ScrollerHolder>
        {context => (
          <VirtualMessageList
            count={500}
            getKey={index => `key-${index}`}
            getScrollElement={() => context.current}
            renderRow={renderRow}
          />
        )}
      </ScrollerHolder>
    )
    expect(container.querySelectorAll('[data-index]').length).toBeGreaterThan(0)
  })

  it('条数超过阈值时只挂载视口附近的行，并保留滚动高度', () => {
    const { container } = render(
      <VirtualMessageList
        count={500}
        getKey={index => `key-${index}`}
        getScrollElement={scroller}
        renderRow={renderRow}
      />
    )
    const mounted = container.querySelectorAll('[data-index]')
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThan(50)
    expect(mounted[0]).toHaveStyle({ position: 'absolute' })
    expect(screen.queryByText('row-499')).not.toBeInTheDocument()
    // 未挂载的行仍要占位，否则滚动条和钉底计算会失真。
    expect(container.firstElementChild).toHaveStyle({ position: 'relative' })
    expect(container.firstElementChild).toHaveStyle({
      height: `${500 * ROW_HEIGHT}px`,
    })
  })
})
