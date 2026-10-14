import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ frame: undefined as undefined | ((time: number) => void), values: [] as Array<{ set: ReturnType<typeof vi.fn> }> }))
vi.mock('motion/react', () => ({
  motion: { div: 'div' },
  useAnimationFrame: (frame: (time: number) => void) => { h.frame = frame },
  useMotionValue: () => { const value = { set: vi.fn() }; h.values.push(value); return value },
  useMotionTemplate: () => '',
  useReducedMotion: () => false,
}))
import { MovingBorder } from '../MovingBorder'
it('skips hidden SVG geometry and resumes after transient WebKit invalid state', () => {
  const { container } = render(<MovingBorder>test</MovingBorder>)
  const path = container.querySelector('rect')!
  path.getClientRects = vi.fn().mockReturnValue([])
  path.getTotalLength = vi.fn().mockReturnValue(100)
  path.getPointAtLength = vi.fn().mockImplementationOnce(() => { throw new DOMException('hidden', 'InvalidStateError') }).mockReturnValue({ x: 3, y: 4 })
  h.frame!(100)
  expect(path.getTotalLength).not.toHaveBeenCalled()
  vi.mocked(path.getClientRects).mockReturnValue([{}] as unknown as DOMRectList)
  expect(() => h.frame!(200)).not.toThrow()
  h.frame!(300)
  expect(h.values[0].set).toHaveBeenLastCalledWith(3)
  expect(h.values[1].set).toHaveBeenLastCalledWith(4)
})

it('空闲时保持挂载但不再计算位置', () => {
  const { container } = render(<MovingBorder active={false}>test</MovingBorder>)
  const path = container.querySelector('rect')!
  path.getClientRects = vi.fn().mockReturnValue([{}] as unknown as DOMRectList)
  path.getTotalLength = vi.fn().mockReturnValue(100)
  h.frame!(100)
  expect(path.getTotalLength).not.toHaveBeenCalled()
  // 组件仍在文档中：状态翻转不再卸载重挂动画，避免边框闪烁。
  expect(container.querySelector('rect')).not.toBeNull()
})
