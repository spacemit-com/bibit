import { describe, expect, it, vi } from 'vitest'
import { createPermissionRequestLedger } from '../permissionRequestLedger'

describe('permissionRequestLedger', () => {
  it('returns the same promise for duplicate pending and terminal requests', async () => {
    const ledger = createPermissionRequestLedger<boolean>()
    const first = ledger.request('request-1', 'thread-1')
    const duplicate = ledger.request('request-1', 'thread-1')

    expect(duplicate.promise).toBe(first.promise)
    expect(duplicate.isNew).toBe(false)
    expect(ledger.decide('request-1', true)).toBe(true)
    expect(ledger.decide('request-1', false)).toBe(false)
    await expect(first.promise).resolves.toBe(true)

    const terminal = ledger.request('request-1', 'thread-1')
    expect(terminal.promise).toBe(first.promise)
    await expect(terminal.promise).resolves.toBe(true)
  })

  it('denies and releases pending requests when a thread or ledger is cleared', async () => {
    const ledger = createPermissionRequestLedger<boolean>()
    const a = ledger.request('a', 'thread-a').promise
    const b = ledger.request('b', 'thread-b').promise
    const c = ledger.request('c').promise

    expect(ledger.clearThread('thread-a', false)).toBe(1)
    await expect(a).resolves.toBe(false)
    expect(ledger.state('a')).toBe('terminal')
    expect(ledger.state('b')).toBe('pending')

    expect(ledger.clear(false)).toBe(2)
    await expect(Promise.all([b, c])).resolves.toEqual([false, false])
  })

  it('never replaces the first resolver', async () => {
    const ledger = createPermissionRequestLedger<boolean>()
    const first = ledger.request('stable', 'thread').promise
    const observer = vi.fn()
    void first.then(observer)
    ledger.request('stable', 'other-thread')
    ledger.decide('stable', false)
    await first
    expect(observer).toHaveBeenCalledOnce()
    expect(observer).toHaveBeenCalledWith(false)
  })
})
