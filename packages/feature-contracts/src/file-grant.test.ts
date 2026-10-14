import { describe, expect, it } from 'vitest'
import {
  FILE_GRANT_DIRECTIONS_V1,
  FILE_GRANT_LIMITS_V1,
  isSafeProviderResourcePathV1,
} from './file-grant'

describe('Feature FileGrant v1', () => {
  it('fixes the public directions and resource limits', () => {
    expect(FILE_GRANT_DIRECTIONS_V1).toEqual(['upload', 'download'])
    expect(FILE_GRANT_LIMITS_V1).toEqual({
      maxActivePerFeatureService: 4,
      maxFileBytes: 256 * 1024 * 1024,
      maxStagingBytesPerFeatureService: 512 * 1024 * 1024,
    })
  })

  it.each([
    'incoming/grant-1.bin',
    'outgoing/job-1/result.bin',
    'packages/agent.tar.gz',
  ])('accepts a safe provider-relative resource path: %s', (path) => {
    expect(isSafeProviderResourcePathV1(path)).toBe(true)
  })

  it.each([
    '/tmp/agent.bin',
    '../agent.bin',
    'incoming/../agent.bin',
    'C:\\Users\\agent.bin',
    'incoming//agent.bin',
    './agent.bin',
    '',
  ])('rejects an unsafe provider resource path: %s', (path) => {
    expect(isSafeProviderResourcePathV1(path)).toBe(false)
  })
})
