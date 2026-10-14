/**
 * 性能监控和诊断工具
 *
 * 用于诊断界面冻结问题：
 * - 监控 Tauri invoke 调用频率和耗时
 * - 检测主线程长任务（Long Task）
 * - 记录事件队列堆积情况
 */

interface InvokeMetric {
  command: string
  startTime: number
  endTime?: number
  duration?: number
  blocked?: boolean
}

interface LongTaskMetric {
  startTime: number
  duration: number
  stackTrace?: string
}

class PerformanceMonitor {
  private invokeMetrics: InvokeMetric[] = []
  private longTasks: LongTaskMetric[] = []
  private pendingInvokes = new Map<string, number>()
  private enabled = false
  private readonly LONG_TASK_THRESHOLD = 50 // 毫秒
  private readonly MAX_METRICS = 1000

  /**
   * 启用性能监控（开发/诊断模式）
   */
  enable() {
    this.enabled = true
    this.setupLongTaskObserver()
    console.log('[PerformanceMonitor] 已启用性能监控')
  }

  /**
   * 禁用性能监控
   */
  disable() {
    this.enabled = false
    console.log('[PerformanceMonitor] 已禁用性能监控')
  }

  /**
   * 记录 Tauri invoke 调用开始
   */
  recordInvokeStart(command: string, args?: unknown) {
    if (!this.enabled) return

    const key = this.getInvokeKey(command, args)
    const now = performance.now()

    // 检测重复调用（前一个调用未完成）
    const pending = this.pendingInvokes.get(key)
    const blocked = pending !== undefined

    if (blocked) {
      console.warn(
        `[PerformanceMonitor] 检测到重复调用: ${command}`,
        `上次调用已持续 ${Math.round(now - pending)}ms`,
        args
      )
    }

    this.pendingInvokes.set(key, now)
    this.invokeMetrics.push({
      command,
      startTime: now,
      blocked,
    })

    // 限制记录数量
    if (this.invokeMetrics.length > this.MAX_METRICS) {
      this.invokeMetrics = this.invokeMetrics.slice(-this.MAX_METRICS / 2)
    }
  }

  /**
   * 记录 Tauri invoke 调用完成
   */
  recordInvokeEnd(command: string, args?: unknown, error?: Error) {
    if (!this.enabled) return

    const key = this.getInvokeKey(command, args)
    const now = performance.now()
    const startTime = this.pendingInvokes.get(key)

    if (startTime === undefined) {
      console.warn(`[PerformanceMonitor] 找不到 invoke 起始记录: ${command}`)
      return
    }

    const duration = now - startTime
    this.pendingInvokes.delete(key)

    // 更新最后一条匹配的记录
    for (let i = this.invokeMetrics.length - 1; i >= 0; i--) {
      const metric = this.invokeMetrics[i]
      if (metric.command === command && metric.startTime === startTime && !metric.endTime) {
        metric.endTime = now
        metric.duration = duration
        break
      }
    }

    // 警告慢调用
    if (duration > 1000) {
      console.warn(
        `[PerformanceMonitor] 慢调用: ${command} 耗时 ${Math.round(duration)}ms`,
        error ? `错误: ${error.message}` : '成功',
        args
      )
    }
  }

  /**
   * 记录长任务（主线程阻塞）
   */
  private recordLongTask(duration: number, stackTrace?: string) {
    this.longTasks.push({
      startTime: performance.now(),
      duration,
      stackTrace,
    })

    if (this.longTasks.length > this.MAX_METRICS) {
      this.longTasks = this.longTasks.slice(-this.MAX_METRICS / 2)
    }

    console.warn(
      `[PerformanceMonitor] 检测到长任务: ${Math.round(duration)}ms`,
      stackTrace
    )
  }

  /**
   * 设置 Long Task 观察器
   */
  private setupLongTaskObserver() {
    if (typeof PerformanceObserver === 'undefined') return

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > this.LONG_TASK_THRESHOLD) {
            this.recordLongTask(entry.duration)
          }
        }
      })

      observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      console.warn('[PerformanceMonitor] Long Task API 不可用:', error)
    }
  }

  /**
   * 获取诊断报告
   */
  getReport() {
    const now = performance.now()
    const recentWindow = 10000 // 最近 10 秒

    // 最近的 invoke 调用统计
    const recentInvokes = this.invokeMetrics.filter(
      (m) => now - m.startTime < recentWindow
    )

    const invokeStats = recentInvokes.reduce(
      (acc, metric) => {
        const cmd = metric.command
        if (!acc[cmd]) {
          acc[cmd] = { count: 0, blocked: 0, totalDuration: 0, maxDuration: 0 }
        }
        acc[cmd].count++
        if (metric.blocked) acc[cmd].blocked++
        if (metric.duration) {
          acc[cmd].totalDuration += metric.duration
          acc[cmd].maxDuration = Math.max(acc[cmd].maxDuration, metric.duration)
        }
        return acc
      },
      {} as Record<string, { count: number; blocked: number; totalDuration: number; maxDuration: number }>
    )

    // 当前挂起的调用
    const pendingCalls = Array.from(this.pendingInvokes.entries()).map(
      ([key, startTime]) => ({
        key,
        duration: Math.round(now - startTime),
      })
    )

    // 最近的长任务
    const recentLongTasks = this.longTasks.filter(
      (t) => now - t.startTime < recentWindow
    )

    return {
      enabled: this.enabled,
      timestamp: new Date().toISOString(),
      window: `最近 ${recentWindow}ms`,
      invokeStats,
      pendingCalls,
      longTasks: recentLongTasks.map((t) => ({
        duration: Math.round(t.duration),
        ago: Math.round(now - t.startTime),
      })),
      summary: {
        totalInvokes: recentInvokes.length,
        blockedInvokes: recentInvokes.filter((m) => m.blocked).length,
        pendingCount: pendingCalls.length,
        longTaskCount: recentLongTasks.length,
      },
    }
  }

  /**
   * 打印诊断报告到控制台
   */
  printReport() {
    const report = this.getReport()
    console.group('[PerformanceMonitor] 诊断报告')
    console.log('时间范围:', report.window)
    console.log('总调用数:', report.summary.totalInvokes)
    console.log('被阻止调用:', report.summary.blockedInvokes)
    console.log('当前挂起:', report.summary.pendingCount)
    console.log('长任务数:', report.summary.longTaskCount)
    console.table(report.invokeStats)
    if (report.pendingCalls.length > 0) {
      console.log('挂起的调用:', report.pendingCalls)
    }
    if (report.longTasks.length > 0) {
      console.log('长任务:', report.longTasks)
    }
    console.groupEnd()
  }

  /**
   * 清空所有记录
   */
  clear() {
    this.invokeMetrics = []
    this.longTasks = []
    this.pendingInvokes.clear()
    console.log('[PerformanceMonitor] 已清空所有记录')
  }

  private getInvokeKey(command: string, args?: unknown): string {
    return args ? `${command}:${JSON.stringify(args)}` : command
  }
}

export const performanceMonitor = new PerformanceMonitor()

// 在开发环境自动启用
if (import.meta.env.DEV) {
  performanceMonitor.enable()
}

declare global {
  interface Window {
    __perfMonitor?: PerformanceMonitor
  }
}

// 暴露到全局便于调试
if (typeof window !== 'undefined') {
  window.__perfMonitor = performanceMonitor
}
