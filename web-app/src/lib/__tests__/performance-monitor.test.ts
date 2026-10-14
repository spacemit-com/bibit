import { describe, it, expect, beforeEach, vi } from 'vitest'
import { performanceMonitor } from '../performance-monitor'

describe('PerformanceMonitor', () => {
  beforeEach(() => {
    performanceMonitor.clear()
    performanceMonitor.enable()
  })

  it('should record invoke start and end', () => {
    performanceMonitor.recordInvokeStart('test_command')
    performanceMonitor.recordInvokeEnd('test_command')

    const report = performanceMonitor.getReport()
    expect(report.summary.totalInvokes).toBe(1)
    expect(report.invokeStats.test_command).toBeDefined()
    expect(report.invokeStats.test_command.count).toBe(1)
  })

  it('should detect duplicate calls', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    performanceMonitor.recordInvokeStart('test_command')
    performanceMonitor.recordInvokeStart('test_command') // 重复调用

    const report = performanceMonitor.getReport()
    expect(report.summary.blockedInvokes).toBe(1)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('检测到重复调用'),
      expect.anything(),
      undefined
    )

    consoleSpy.mockRestore()
  })

  it('should track pending invokes', () => {
    performanceMonitor.recordInvokeStart('test_command')

    const report = performanceMonitor.getReport()
    expect(report.summary.pendingCount).toBe(1)
    expect(report.pendingCalls[0].key).toBe('test_command')

    performanceMonitor.recordInvokeEnd('test_command')

    const report2 = performanceMonitor.getReport()
    expect(report2.summary.pendingCount).toBe(0)
  })

  it('should warn on slow calls', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    performanceMonitor.recordInvokeStart('slow_command')

    // 模拟慢调用（待完成队列里的起始时间决定真实耗时）
    const pending = (performanceMonitor as any).pendingInvokes as Map<string, number>
    pending.set('slow_command', performance.now() - 1500)

    performanceMonitor.recordInvokeEnd('slow_command')

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('慢调用'),
      expect.anything(),
      undefined
    )

    consoleSpy.mockRestore()
  })

  it('should differentiate calls by arguments', () => {
    performanceMonitor.recordInvokeStart('test_command', { id: 1 })
    performanceMonitor.recordInvokeStart('test_command', { id: 2 })

    const report = performanceMonitor.getReport()
    expect(report.summary.pendingCount).toBe(2) // 两个不同的调用
  })

  it('should clear all records', () => {
    performanceMonitor.recordInvokeStart('test_command')
    performanceMonitor.recordInvokeEnd('test_command')

    let report = performanceMonitor.getReport()
    expect(report.summary.totalInvokes).toBe(1)

    performanceMonitor.clear()

    report = performanceMonitor.getReport()
    expect(report.summary.totalInvokes).toBe(0)
    expect(report.summary.pendingCount).toBe(0)
  })

  it('should limit stored metrics', () => {
    const MAX_METRICS = 1000

    // 记录超过限制的调用
    for (let i = 0; i < MAX_METRICS + 100; i++) {
      performanceMonitor.recordInvokeStart(`command_${i}`)
      performanceMonitor.recordInvokeEnd(`command_${i}`)
    }

    const metrics = (performanceMonitor as any).invokeMetrics
    expect(metrics.length).toBeLessThanOrEqual(MAX_METRICS)
  })

  it('should generate report with statistics', () => {
    // 模拟多次调用
    for (let i = 0; i < 5; i++) {
      performanceMonitor.recordInvokeStart('command_a')
      performanceMonitor.recordInvokeEnd('command_a')
    }

    for (let i = 0; i < 3; i++) {
      performanceMonitor.recordInvokeStart('command_b')
      performanceMonitor.recordInvokeEnd('command_b')
    }

    const report = performanceMonitor.getReport()

    expect(report.summary.totalInvokes).toBe(8)
    expect(report.invokeStats.command_a.count).toBe(5)
    expect(report.invokeStats.command_b.count).toBe(3)
  })

  it('should not record when disabled', () => {
    performanceMonitor.disable()

    performanceMonitor.recordInvokeStart('test_command')
    performanceMonitor.recordInvokeEnd('test_command')

    const report = performanceMonitor.getReport()
    expect(report.enabled).toBe(false)
    expect(report.summary.totalInvokes).toBe(0)
  })
})
