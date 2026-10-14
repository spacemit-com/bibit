import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DefaultAppService } from '../default'

describe('DefaultAppService', () => {
  let svc: DefaultAppService

  beforeEach(() => {
    svc = new DefaultAppService()
    vi.restoreAllMocks()
  })

  describe('readLogs', () => {
    it('returns empty array', async () => {
      const result = await svc.readLogs()
      expect(result).toEqual([])
    })
  })

  describe('parseLogLine', () => {
    it('parses a line into a LogEntry', () => {
      const entry = svc.parseLogLine('some log message')
      expect(entry).toEqual({
        timestamp: expect.any(Number),
        level: 'info',
        target: 'default',
        message: 'some log message',
      })
    })

    it('handles empty string', () => {
      const entry = svc.parseLogLine('')
      expect(entry.message).toBe('')
    })
  })

  describe('getJanDataFolder', () => {
    it('returns undefined', async () => {
      const result = await svc.getJanDataFolder()
      expect(result).toBeUndefined()
    })
  })

  describe('getServerStatus', () => {
    it('returns false', async () => {
      const result = await svc.getServerStatus()
      expect(result).toBe(false)
    })
  })

  describe('readYaml', () => {
    it('throws not implemented error', async () => {
      await expect(svc.readYaml('/some/path')).rejects.toThrow(
        'readYaml not implemented in default app service'
      )
    })
  })
})
