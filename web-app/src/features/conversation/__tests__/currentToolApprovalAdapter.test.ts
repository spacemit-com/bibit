import { describe, expect, it, vi } from 'vitest'
import {
  applyCurrentToolDecision,
  toCurrentToolPermissionRequest,
} from '../adapters/currentToolApprovalAdapter'
import type { PendingApproval } from '@/hooks/useToolApprovalRequests'

describe('currentToolApprovalAdapter', () => {
  it('maps the current pending tool request without logging sensitive details', () => {
    const log = vi.spyOn(console, 'log')
    const pending = {
      toolCallId: 'tc-1',
      toolName: 'shell',
      threadId: 'thread-1',
      toolParameters: { token: 'do-not-log' },
      createdAt: '2026-08-19T00:00:00.000Z',
    } satisfies PendingApproval
    const request = toCurrentToolPermissionRequest(pending)

    expect(request).toMatchObject({
      runtimeId: 'current-tool-approval',
      runtimeEpoch: expect.any(String),
      runtimeInstanceId: expect.any(String),
      sessionId: 'thread-1',
      requestId: 'tc-1',
      threadId: 'thread-1',
      runId: expect.any(String),
      toolCallId: 'tc-1',
      action: { kind: 'tool', name: 'shell' },
      supportedDecisions: ['allow_once', 'deny'],
      createdAt: pending.createdAt,
      expiresAt: expect.any(String),
    })
    expect(JSON.stringify(request)).not.toContain('do-not-log')
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['allow_once', 'allow-once'],
    ['deny', 'deny'],
  ] as const)('returns an accepted host receipt for %s', async (decision, expected) => {
    const resolve = vi.fn()
    const request = toCurrentToolPermissionRequest({
      toolCallId: 'tc-1',
      toolName: 'shell',
      threadId: 'thread-1',
      createdAt: '2026-08-19T00:00:00.000Z',
    })
    const identity = {
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeId: request.runtimeId,
      runtimeEpoch: request.runtimeEpoch,
      sessionId: request.sessionId,
      threadId: request.threadId,
      runId: request.runId,
      requestId: request.requestId,
      toolCallId: request.toolCallId,
    }
    const permissionDecision = decision === 'deny'
      ? {
        version: 1 as const,
        ...identity,
        decision: 'deny' as const,
        reason: 'user-denied' as const,
      }
      : { version: 1 as const, ...identity, decision: 'allow_once' as const }
    const receipt = await applyCurrentToolDecision(
      request,
      permissionDecision,
      resolve
    )
    expect(resolve).toHaveBeenCalledWith('tc-1', expected)
    expect(receipt.status).toBe('accepted')
    expect(receipt.runtimeInstanceId).toBe(request.runtimeInstanceId)
  })

  it('returns stale without resolving for an identity mismatch', async () => {
    const resolve = vi.fn()
    const request = toCurrentToolPermissionRequest({
      toolCallId: 'tc-1', toolName: 'shell', threadId: 'thread-1', createdAt: '2026-08-19T00:00:00.000Z',
    })
    const receipt = await applyCurrentToolDecision(request, {
      version: 1,
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeId: request.runtimeId,
      runtimeEpoch: request.runtimeEpoch,
      sessionId: request.sessionId,
      threadId: request.threadId,
      runId: request.runId,
      requestId: request.requestId,
      toolCallId: 'other-tool',
      decision: 'deny',
      reason: 'user-denied',
    }, resolve)

    expect(receipt.status).toBe('stale')
    expect(resolve).not.toHaveBeenCalled()
  })
})
