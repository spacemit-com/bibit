import { describe, expect, it, vi } from 'vitest'
import { cancelCoordinatedSessionRun } from '@/lib/coordinated-stop'

describe('coordinated conversation stop', () => {
  it('cancels the session run through the desktop command when enabled', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(true)

    await expect(
      cancelCoordinatedSessionRun('thread-1', true, invokeCommand)
    ).resolves.toBe(true)
    expect(invokeCommand).toHaveBeenCalledWith(
      'conversation_cancel_session_run',
      { sessionId: 'thread-1' }
    )
  })

  it('cancels a formal runtime run through the runtime gateway command', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({ accepted: true, duplicate: false })

    await expect(
      cancelCoordinatedSessionRun('thread-1', true, invokeCommand, true)
    ).resolves.toBe(true)
    expect(invokeCommand).toHaveBeenCalledWith(
      'conversation_cancel_runtime_run',
      { sessionId: 'thread-1' }
    )
  })

  it('does nothing outside the desktop runtime', async () => {
    const invokeCommand = vi.fn()
    await expect(
      cancelCoordinatedSessionRun('thread-1', false, invokeCommand)
    ).resolves.toBe(false)
    expect(invokeCommand).not.toHaveBeenCalled()
  })
})
