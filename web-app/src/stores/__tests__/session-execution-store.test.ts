import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionBusyTimings, sessionBusyReport, setSessionBusyTimingsEnabled } from '@/lib/session-busy-timings'
import { MIN_BUSY_HOLD_MS, useSessionExecutionStore } from '../session-execution-store'

const store = () => useSessionExecutionStore.getState()
const phaseOf = (key: string) => store().executions[key]?.phase ?? 'idle'

beforeEach(() => {
  vi.useFakeTimers()
  useSessionExecutionStore.setState({ executions: {} })
  resetSessionBusyTimings()
  setSessionBusyTimingsEnabled(true)
})

afterEach(() => {
  setSessionBusyTimingsEnabled(false)
  vi.useRealTimers()
})

it('提交后 20 秒钩子空档内保持忙碌', () => {
  store().markSubmit('k')
  expect(phaseOf('k')).toBe('submitting')
  // 认领后本地已无未认领输入，但 Runtime 还没上报执行视图、也没有任何内容事件。
  for (let second = 0; second < 20; second += 1) {
    vi.advanceTimersByTime(1_000)
    store().observe('k', { contentRunning: false, unclaimedInputs: 0, pendingApprovals: 0 })
  }
  expect(phaseOf('k')).not.toBe('idle')
})

it('权威视图报告运行中时立即进入忙碌', () => {
  store().observe('k', { view: { running: true, waiting: false, activeRunId: 'run-1' }, contentRunning: false })
  expect(phaseOf('k')).toBe('running')
})

it('Run 终态但权威视图仍运行中时保持忙碌', () => {
  store().observe('k', { view: { running: true, activeRunId: 'run-1' }, contentRunning: true })
  store().observe('k', { view: { running: true, activeRunId: 'run-1' }, contentRunning: false })
  vi.advanceTimersByTime(MIN_BUSY_HOLD_MS * 4)
  expect(phaseOf('k')).toBe('running')
})

it('权威空闲后跨过保持窗口才退出，且只进出一次', () => {
  store().observe('k', { view: { running: true, activeRunId: 'run-1' } })
  store().observe('k', { view: { running: false, waiting: false, activeRunId: null } })
  vi.advanceTimersByTime(MIN_BUSY_HOLD_MS - 1)
  expect(phaseOf('k')).toBe('running')
  vi.advanceTimersByTime(1)
  expect(phaseOf('k')).toBe('idle')
  expect(sessionBusyReport('k').sessions).toEqual([{ key: 'k', entries: 1, exits: 1 }])
})

it('待审批仍是忙碌，但阶段可区分', () => {
  store().observe('k', { view: { running: false, waiting: true, activeRunId: 'run-1' } })
  expect(phaseOf('k')).toBe('waiting_approval')
  store().observe('k', { view: { running: false, waiting: false, activeRunId: null } })
  vi.advanceTimersByTime(MIN_BUSY_HOLD_MS)
  expect(phaseOf('k')).toBe('idle')
})

it('没有执行视图时按内容信号进出，且空档期不提前退出', () => {
  store().markSubmit('k')
  store().observe('k', { contentRunning: false })
  vi.advanceTimersByTime(MIN_BUSY_HOLD_MS * 2)
  expect(phaseOf('k')).not.toBe('idle')
  store().observe('k', { contentRunning: true })
  vi.advanceTimersByTime(50)
  store().observe('k', { contentRunning: false })
  vi.advanceTimersByTime(MIN_BUSY_HOLD_MS)
  expect(phaseOf('k')).toBe('idle')
  expect(sessionBusyReport('k').sessions).toEqual([{ key: 'k', entries: 1, exits: 1 }])
})

it('重复的权威帧不产生额外进出', () => {
  for (let index = 0; index < 10; index += 1) {
    store().observe('k', { view: { running: true, waiting: false, activeRunId: 'run-1' } })
  }
  store().observe('k', { view: { running: false, waiting: false, activeRunId: null } })
  vi.advanceTimersByTime(MIN_BUSY_HOLD_MS)
  expect(sessionBusyReport('k').sessions).toEqual([{ key: 'k', entries: 1, exits: 1 }])
})

it('清除后不再保留忙碌状态', () => {
  store().observe('k', { view: { running: true, activeRunId: 'run-1' } })
  store().clear('k')
  expect(phaseOf('k')).toBe('idle')
})
