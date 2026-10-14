import { beforeEach, expect, it } from 'vitest'
import {
  recordBusyTransition,
  resetSessionBusyTimings,
  sessionBusyReport,
  sessionBusyTimingsEnabled,
  setSessionBusyTimingsEnabled,
} from '../session-busy-timings'

beforeEach(() => {
  setSessionBusyTimingsEnabled(false)
  resetSessionBusyTimings()
})

it('默认关闭时不记录任何样本', () => {
  expect(sessionBusyTimingsEnabled()).toBe(false)
  recordBusyTransition({ key: 'k', phase: 'running', source: 'runtime-view', at: 1 })
  expect(sessionBusyReport().transitions).toBe(0)
})

it('打开后按会话统计进入与退出', () => {
  setSessionBusyTimingsEnabled(true)
  recordBusyTransition({ key: 'k', phase: 'submitting', source: 'submit', at: 1 })
  recordBusyTransition({ key: 'k', phase: 'running', source: 'runtime-view', at: 2 })
  recordBusyTransition({ key: 'k', phase: 'idle', source: 'hold', at: 3 })
  const report = sessionBusyReport('k')
  expect(report.transitions).toBe(3)
  expect(report.sessions).toEqual([{ key: 'k', entries: 1, exits: 1 }])
  expect(report.timeline.map(item => item.phase)).toEqual(['submitting', 'running', 'idle'])
})

it('按会话键过滤时间线', () => {
  setSessionBusyTimingsEnabled(true)
  recordBusyTransition({ key: 'a', phase: 'running', source: 'runtime-view', at: 1 })
  recordBusyTransition({ key: 'b', phase: 'idle', source: 'hold', at: 2 })
  expect(sessionBusyReport('a').sessions).toEqual([{ key: 'a', entries: 1, exits: 0 }])
})

it('关闭时清空已有样本', () => {
  setSessionBusyTimingsEnabled(true)
  recordBusyTransition({ key: 'k', phase: 'running', source: 'runtime-view', at: 1 })
  setSessionBusyTimingsEnabled(false)
  expect(sessionBusyReport().transitions).toBe(0)
})
