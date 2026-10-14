// 启动阶段计时。每个 webview 打印 `[startup]` 汇总行：各阶段相对 `timeOrigin` 的毫秒
// （`performance.now()` 本身就是这个基准），与 Rust 侧 `startup-trace.log` 的 epoch
// 毫秒同一口钟，按 `timeOrigin + 值` 即可对齐，用来把首屏拆成可归因的几段。
// 汇总行走既有的 console 转发（Rust 写进 app.log），所以不需要新增 IPC 命令。
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

const marks: Array<[string, number]> = []

const windowLabel = (): string => {
  try {
    return getCurrentWebviewWindow().label
  } catch {
    return 'unknown'
  }
}

// 首屏阻塞集的实测成本：每个被加载的 JS/CSS/图片资源耗时（含解压与传输）。
const resourceSummary = (): string => {
  try {
    const entries = performance.getEntriesByType(
      'resource'
    ) as PerformanceResourceTiming[]
    const slow = entries
      .filter((e) => e.duration >= 50)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 14)
      .map(
        (e) =>
          `${e.name.split('/').pop()}=${Math.round(e.duration)}ms@${Math.round(e.startTime)}`
      )
    return `resources=${entries.length} slow=${slow.join(',')}`
  } catch {
    return 'resources=unavailable'
  }
}

export const traceStartup = (name: string): void => {
  // 之前这里减掉模块求值时刻，mark 就变成相对本模块 import 的偏移，而汇总行按
  // `timeOrigin` 对齐，前端各阶段因此被低估约 0.5s（入口 bundle 的解析耗时）。
  marks.push([name, performance.now()])
}

export const logStartupTrace = (final = false): void => {
  const body = marks.map(([name, at]) => `${name}=${at.toFixed(1)}`).join(' ')
  console.info(
    `[startup] label=${windowLabel()} timeOrigin=${Math.round(performance.timeOrigin)} final=${final}${body ? ` ${body}` : ''}`
  )
  if (final) console.info(`[startup-res] label=${windowLabel()} ${resourceSummary()}`)
}
