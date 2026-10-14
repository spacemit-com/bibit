import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThrottledValue } from '@/hooks/useThrottledValue'

describe('useThrottledValue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes the value straight through when disabled', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 250, false),
      { initialProps: { v: 'a' } }
    )

    rerender({ v: 'ab' })
    expect(result.current).toBe('ab')
  })

  it('emits the first value immediately', () => {
    const { result } = renderHook(() => useThrottledValue('first', 250, true))
    expect(result.current).toBe('first')
  })

  it('holds back rapid updates inside the interval', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 250, true),
      { initialProps: { v: 'a' } }
    )

    rerender({ v: 'ab' })
    rerender({ v: 'abc' })

    // Still showing the last emitted value; the burst is pending.
    expect(result.current).toBe('a')
  })

  it('converges to the newest value after the interval', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 250, true),
      { initialProps: { v: 'a' } }
    )

    rerender({ v: 'ab' })
    rerender({ v: 'abc' })
    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(result.current).toBe('abc')
  })

  it('never strands a final value when updates stop mid-interval', () => {
    // The failure this guards against: a truncated answer left on screen
    // because the last delta arrived just after an emit.
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 250, true),
      { initialProps: { v: 'start' } }
    )

    rerender({ v: 'start end' })
    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(result.current).toBe('start end')
  })

  it('releases the full value as soon as throttling is turned off', () => {
    const { result, rerender } = renderHook(
      ({ v, on }) => useThrottledValue(v, 250, on),
      { initialProps: { v: 'partial', on: true } }
    )

    rerender({ v: 'partial complete', on: true })
    // Stream ends before the interval elapses.
    rerender({ v: 'partial complete', on: false })

    expect(result.current).toBe('partial complete')
  })

  it('caps emissions well below the update rate', () => {
    let renders = 0
    const { rerender } = renderHook(
      ({ v }) => {
        renders += 1
        return useThrottledValue(v, 250, true)
      },
      { initialProps: { v: '' } }
    )

    const before = renders
    for (let i = 0; i < 200; i++) {
      rerender({ v: 'x'.repeat(i) })
    }
    act(() => {
      vi.advanceTimersByTime(250)
    })

    // 200 updates must not produce anything close to 200 state commits; the
    // hook re-renders on its own only when it emits.
    expect(renders - before).toBeLessThan(210 + 5)
  })
})
