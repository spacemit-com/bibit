import { describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ handler: undefined as undefined | ((event: { payload: unknown }) => void), error: undefined as string | undefined, stop: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, callback) => { h.handler = callback; return h.stop }),
  emitTo: vi.fn(async (_window, _event, payload) => {
    h.handler?.({ payload: { id: 'unrelated' } })
    h.handler?.({ payload: { id: payload.id, error: h.error } })
  }),
}))
import { handoffOverlay } from '../overlay-handoff'
describe('浮窗草稿交接确认', () => {
  it('匹配确认后成功，目标拒绝时保留失败并移除监听', async () => {
    h.error = undefined
    await expect(handoffOverlay({ draft: '未提交草稿', attachments: [], runtimeEnabled: false })).resolves.toBeUndefined()
    expect(h.stop).toHaveBeenCalledTimes(1)
    h.error = 'Runtime 已切换'
    await expect(handoffOverlay({ draft: '仍需保留', attachments: [], runtimeEnabled: true, targetId: 'old' })).rejects.toThrow('Runtime 已切换')
    expect(h.stop).toHaveBeenCalledTimes(2)
  })
})
