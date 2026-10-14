import { describe, expect, it } from 'vitest'
import type { RuntimePermissionData } from '@/lib/runtime-contract'
import {
  toRuntimePermissionRequest,
  toRuntimePermissionResolveRequest,
} from '../adapters/runtimePermissionAdapter'

const runtimeRequest: RuntimePermissionData = {
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-1',
  sessionId: 'thread-1',
  runId: 'run-1',
  createdAt: '2026-08-19T00:00:00.000Z',
  expiresAt: '2026-08-19T00:01:00.000Z',
  requestId: 'permission-1',
  toolCallId: 'tool-1',
  title: 'Allow command',
  description: 'Hermes requests a command',
  toolName: 'shell',
  inputSummary: {
    command: 'pwd',
    authorization: 'Bearer secret-that-must-not-cross-the-boundary',
  },
  canAllowOnce: true,
  canDeny: true,
  status: 'pending',
}

describe('runtime permission adapter', () => {
  it('projects correlation and supported scope without exposing raw input', () => {
    const request = toRuntimePermissionRequest(runtimeRequest)

    expect(request).toMatchObject({
      runtimeInstanceId: 'hermes:epoch-1',
      requestId: 'permission-1',
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      runId: 'run-1',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      toolCallId: 'tool-1',
      supportedDecisions: ['allow_once', 'deny'],
      createdAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2026-08-19T00:01:00.000Z',
    })
    expect(JSON.stringify(request)).not.toContain('Bearer secret')
    expect(request.action.details).toBeUndefined()
  })

  it('maps allow once and deny to the Runtime contract', () => {
    expect(
      toRuntimePermissionResolveRequest(runtimeRequest, {
        version: 1,
        runtimeInstanceId: 'hermes:epoch-1',
        requestId: 'permission-1',
        runtimeId: 'hermes',
        runtimeEpoch: 'epoch-1',
        sessionId: 'thread-1',
        threadId: 'thread-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        decision: 'allow_once',
      })
    ).toEqual({
      runtimeInstanceId: 'hermes:epoch-1',
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      runId: 'run-1',
      requestId: 'permission-1',
      toolCallId: 'tool-1',
      decision: 'allow_once',
    })
    expect(
      toRuntimePermissionResolveRequest(runtimeRequest, {
        version: 1,
        runtimeInstanceId: 'hermes:epoch-1',
        requestId: 'permission-1',
        runtimeId: 'hermes',
        runtimeEpoch: 'epoch-1',
        sessionId: 'thread-1',
        threadId: 'thread-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        decision: 'deny',
        reason: 'user-denied',
      })
    ).toEqual({
      runtimeInstanceId: 'hermes:epoch-1',
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      runId: 'run-1',
      requestId: 'permission-1',
      toolCallId: 'tool-1',
      decision: 'deny',
      reason: 'user-denied',
    })
  })

  it.each([
    ['runtimeInstanceId', 'other-instance'],
    ['runtimeId', 'other-runtime'],
    ['runtimeEpoch', 'other-epoch'],
    ['sessionId', 'other-session'],
    ['threadId', 'other-thread'],
    ['runId', 'other-run'],
    ['requestId', 'other-request'],
    ['toolCallId', 'other-tool'],
  ] as const)('rejects mismatched %s', (field, value) => {
    expect(() =>
      toRuntimePermissionResolveRequest(runtimeRequest, {
        version: 1,
        runtimeInstanceId: 'hermes:epoch-1',
        requestId: 'permission-1',
        runtimeId: 'hermes',
        runtimeEpoch: 'epoch-1',
        sessionId: 'thread-1',
        threadId: 'thread-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        decision: 'deny',
        reason: 'user-denied',
        [field]: value,
      })
    ).toThrow('does not match')
  })
})
