import { describe, expect, it } from 'vitest'
import { shouldKeepOverlayConversation } from '../overlay-conversation-store'

describe('浮窗收起边界', () => {
  const finished = { busy: false, draft: '', attachments: 0, pending: 0 }
  it('完成且没有草稿时结束交流，未完成的任务和输入必须保留', () => {
    expect(shouldKeepOverlayConversation(finished)).toBe(false)
    for (const state of [
      { busy: true }, { draft: '草稿' }, { attachments: 1 }, { pending: 1 },
    ]) expect(shouldKeepOverlayConversation({ ...finished, ...state })).toBe(true)
  })
})
