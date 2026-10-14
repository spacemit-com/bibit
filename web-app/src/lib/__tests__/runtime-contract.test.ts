import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RUNTIME_EVENT_NAME,
  RUNTIME_ID,
  RUNTIME_SCHEMA_VERSION,
  RUNTIME_SESSION_ID,
  describeRuntimeCommandError,
  formatRuntimeCommandError,
  isTerminalRuntimeEvent,
  parseCommandAck,
  parsePermissionDecisionReceipt,
  parseRunStartResult,
  parseRuntimeEventEnvelope,
  parseRuntimeSnapshot,
  parseSessionCreateResult,
  runtimeDataPartType,
} from '@/lib/runtime-contract'

const fixture = JSON.parse(
  readFileSync(
    (() => {
      const fixtureUrl = new URL(
        '../../../../tests/fixtures/runtime-contract-v1.json',
        import.meta.url
      )
      return fixtureUrl.protocol === 'file:'
        ? fileURLToPath(fixtureUrl)
        : fixtureUrl.pathname.replace(/^\/\@fs/, '')
    })(),
    'utf8'
  )
) as unknown[]

function fixtureEnvelope(index: number): Record<string, unknown> {
  return structuredClone(fixture[index]) as Record<string, unknown>
}

function expectEnvelopePath(value: unknown, path: string) {
  expect(() => parseRuntimeEventEnvelope(value)).toThrow(path)
}

describe('runtime contract constants', () => {
  it('exports the fixed runtime metadata and data-part names', () => {
    expect(RUNTIME_EVENT_NAME).toBe('runtime-event')
    expect(RUNTIME_SCHEMA_VERSION).toBe('2.0')
    expect(RUNTIME_ID).toBe('hermes')
    expect(RUNTIME_SESSION_ID).toBe('__runtime__')
    expect(runtimeDataPartType).toEqual({
      tool: 'data-runtime-tool',
      permission: 'data-runtime-permission',
      diagnostic: 'data-runtime-diagnostic',
    })
  })
})

describe('parseRuntimeEventEnvelope', () => {
  it('accepts every event from the shared Rust fixture', () => {
    expect(fixture.map(parseRuntimeEventEnvelope)).toEqual(fixture)
  })

  it('keeps the shared permission action projection and digest stable', () => {
    const permission = fixture.find(
      (item) => (item as { event?: { type?: string } }).event?.type === 'permission_requested'
    ) as { event: { request: { actions: unknown[]; actionSetDigest: string } } }
    const canonical = JSON.stringify(permission.event.request.actions)
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      permission.event.request.actionSetDigest
    )
  })

  it('accepts Bianbu as a runtime profile', () => {
    const envelope = fixtureEnvelope(0)
    envelope.runtimeId = 'bianbu'
    expect(parseRuntimeEventEnvelope(envelope).runtimeId).toBe('bianbu')
  })

  it('rejects malformed permission action digests at the contract boundary', () => {
    const envelope = fixtureEnvelope(7)
    const request = (envelope.event as { request: Record<string, unknown> }).request
    request.actionSetDigest = 'deadbeef'
    expectEnvelopePath(envelope, 'envelope.event.request.actionSetDigest')
  })

  it('rejects malformed permission audit action digests at the contract boundary', () => {
    const envelope = fixtureEnvelope(7)
    envelope.event = {
      type: 'permission_audit',
      requestId: 'permission-1',
      decision: 'allow_once',
      status: 'accepted',
      actionSetDigest: 'deadbeef',
    }
    expectEnvelopePath(envelope, 'envelope.event.actionSetDigest')
  })

  it.each([
    ['schemaVersion', '3.0'],
    ['eventId', ''],
    ['sequence', -1],
    ['sequence', 1.5],
    ['runtimeId', 'unknown'],
  ])('rejects invalid envelope field %s', (field, value) => {
    const envelope = fixtureEnvelope(0)
    envelope[field] = value

    expectEnvelopePath(envelope, `envelope.${field}`)
  })

  it('continues to read v1 envelopes during migration', () => {
    const envelope = fixtureEnvelope(2)
    envelope.schemaVersion = '1.0'
    expect(parseRuntimeEventEnvelope(envelope).schemaVersion).toBe('1.0')
  })

  it('rejects non-objects, missing fields, and unknown envelope fields', () => {
    expectEnvelopePath(null, 'envelope')

    const missingEpoch = fixtureEnvelope(0)
    delete missingEpoch.runtimeEpoch
    expectEnvelopePath(missingEpoch, 'envelope.runtimeEpoch')

    const unknownField = fixtureEnvelope(0)
    unknownField.extra = true
    expectEnvelopePath(unknownField, 'envelope.extra')
  })

  it('rejects an inherited envelope field when its own field is missing', () => {
    const envelope = fixtureEnvelope(0)
    delete envelope.runtimeEpoch
    Object.defineProperty(Object.prototype, 'runtimeEpoch', {
      value: 'inherited-epoch',
      configurable: true,
      enumerable: false,
    })

    try {
      expectEnvelopePath(envelope, 'envelope.runtimeEpoch')
    } finally {
      delete (Object.prototype as Record<string, unknown>).runtimeEpoch
    }
  })

  it.each([
    ['runtimeEpoch', ''],
    ['sessionId', ''],
    ['timestamp', ''],
  ])('rejects empty envelope identifier %s', (field, value) => {
    const envelope = fixtureEnvelope(0)
    envelope[field] = value

    expectEnvelopePath(envelope, `envelope.${field}`)
  })

  it('rejects unsafe integer sequences', () => {
    const envelope = fixtureEnvelope(0)
    envelope.sequence = Number.MAX_SAFE_INTEGER + 1

    expectEnvelopePath(envelope, 'envelope.sequence')
  })

  it('enforces runtime-session and run-event runId rules', () => {
    const runtimeWithRun = fixtureEnvelope(0)
    runtimeWithRun.runId = 'run-1'
    expectEnvelopePath(runtimeWithRun, 'envelope.runId')

    const runtimeWithNullRun = fixtureEnvelope(0)
    runtimeWithNullRun.runId = null
    expectEnvelopePath(runtimeWithNullRun, 'envelope.runId')

    const runtimeWithUndefinedRun = fixtureEnvelope(0)
    runtimeWithUndefinedRun.runId = undefined
    expectEnvelopePath(runtimeWithUndefinedRun, 'envelope.runId')

    const runWithoutRunId = fixtureEnvelope(1)
    delete runWithoutRunId.runId
    expectEnvelopePath(runWithoutRunId, 'envelope.runId')

    const runWithEmptyRunId = fixtureEnvelope(1)
    runWithEmptyRunId.runId = ''
    expectEnvelopePath(runWithEmptyRunId, 'envelope.runId')

    const runEventOnRuntimeSession = fixtureEnvelope(1)
    runEventOnRuntimeSession.sessionId = '__runtime__'
    delete runEventOnRuntimeSession.runId
    expectEnvelopePath(runEventOnRuntimeSession, 'envelope.event.type')

    const runtimeEventOnRunSession = fixtureEnvelope(0)
    runtimeEventOnRunSession.sessionId = 'thread-1'
    runtimeEventOnRunSession.runId = 'run-1'
    expectEnvelopePath(runtimeEventOnRunSession, 'envelope.event.type')
  })

  it.each(fixture.map((_, index) => [index]))(
    'rejects unknown fields in event variant fixture[%i]',
    (index) => {
      const envelope = fixtureEnvelope(index)
      const event = envelope.event as Record<string, unknown>
      event.unexpected = true

      expectEnvelopePath(envelope, 'envelope.event.unexpected')
    }
  )

  it.each([
    [0, 'status', 'booting'],
    [0, 'message', null],
    [1, 'userMessageId', ''],
    [2, 'messageId', ''],
    [2, 'delta', 1],
    [3, 'messageId', ''],
    [3, 'delta', false],
    [4, 'toolCallId', ''],
    [4, 'name', 1],
    [5, 'toolCallId', ''],
    [6, 'toolCallId', ''],
    [6, 'error', null],
    [8, 'requestId', ''],
    [8, 'decision', 'always'],
    [9, 'level', 'error'],
    [9, 'message', 1],
    [10, 'stopReason', null],
    [11, 'reason', null],
  ])('rejects invalid fixture[%i].event.%s', (index, field, value) => {
    const envelope = fixtureEnvelope(index as number)
    const event = envelope.event as Record<string, unknown>
    event[field as string] = value

    expectEnvelopePath(envelope, `envelope.event.${field}`)
  })

  it('rejects missing event discriminants and required fields', () => {
    const missingType = fixtureEnvelope(1)
    delete (missingType.event as Record<string, unknown>).type
    expectEnvelopePath(missingType, 'envelope.event.type')

    const missingUserMessageId = fixtureEnvelope(1)
    delete (missingUserMessageId.event as Record<string, unknown>).userMessageId
    expectEnvelopePath(missingUserMessageId, 'envelope.event.userMessageId')

    const missingToolUpdate = fixtureEnvelope(5)
    delete (missingToolUpdate.event as Record<string, unknown>).update
    expectEnvelopePath(missingToolUpdate, 'envelope.event.update')
  })

  it('rejects an inherited event field when its own field is missing', () => {
    const envelope = fixtureEnvelope(1)
    delete (envelope.event as Record<string, unknown>).userMessageId
    Object.defineProperty(Object.prototype, 'userMessageId', {
      value: 'inherited-message',
      configurable: true,
      enumerable: false,
    })

    try {
      expectEnvelopePath(envelope, 'envelope.event.userMessageId')
    } finally {
      delete (Object.prototype as Record<string, unknown>).userMessageId
    }
  })

  it('validates all PermissionRequest fields and rejects schema drift', () => {
    const invalidTitle = fixtureEnvelope(7)
    const invalidTitleRequest = (invalidTitle.event as Record<string, unknown>)
      .request as Record<string, unknown>
    invalidTitleRequest.title = 1
    expectEnvelopePath(invalidTitle, 'envelope.event.request.title')

    const invalidRequestId = fixtureEnvelope(7)
    const invalidRequestIdRequest = (
      invalidRequestId.event as Record<string, unknown>
    ).request as Record<string, unknown>
    invalidRequestIdRequest.requestId = ''
    expectEnvelopePath(invalidRequestId, 'envelope.event.request.requestId')

    const invalidBoolean = fixtureEnvelope(7)
    const invalidBooleanRequest = (
      invalidBoolean.event as Record<string, unknown>
    ).request as Record<string, unknown>
    invalidBooleanRequest.canDeny = 'yes'
    expectEnvelopePath(invalidBoolean, 'envelope.event.request.canDeny')

    const unknownField = fixtureEnvelope(7)
    const unknownFieldRequest = (unknownField.event as Record<string, unknown>)
      .request as Record<string, unknown>
    unknownFieldRequest.extra = true
    expectEnvelopePath(unknownField, 'envelope.event.request.extra')
  })

  it('accepts JSON-compatible tool and permission values including null', () => {
    const values: unknown[] = [
      null,
      'value',
      true,
      1.5,
      [null, { nested: ['value', 2, false] }],
      { nested: { value: 1 } },
    ]

    for (const value of values) {
      const toolStarted = fixtureEnvelope(4)
      ;(toolStarted.event as Record<string, unknown>).input = value
      expect(parseRuntimeEventEnvelope(toolStarted)).toEqual(toolStarted)

      const toolUpdated = fixtureEnvelope(5)
      ;(toolUpdated.event as Record<string, unknown>).update = value
      expect(parseRuntimeEventEnvelope(toolUpdated)).toEqual(toolUpdated)

      const toolCompleted = fixtureEnvelope(6)
      ;(toolCompleted.event as Record<string, unknown>).result = value
      expect(parseRuntimeEventEnvelope(toolCompleted)).toEqual(toolCompleted)

      const permission = fixtureEnvelope(7)
      const request = (permission.event as Record<string, unknown>)
        .request as Record<string, unknown>
      request.inputSummary = value
      expect(parseRuntimeEventEnvelope(permission)).toEqual(permission)
    }
  })

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
    ['bigint', BigInt(1)],
    ['Date', new Date('2026-08-04T00:00:00Z')],
    ['custom prototype', Object.create({ inherited: true })],
  ])('rejects non-JSON tool input: %s', (_name, value) => {
    const envelope = fixtureEnvelope(4)
    ;(envelope.event as Record<string, unknown>).input = value

    expectEnvelopePath(envelope, 'envelope.event.input')
  })

  it('rejects cyclic JSON values with their field path', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const envelope = fixtureEnvelope(5)
    ;(envelope.event as Record<string, unknown>).update = cyclic

    expectEnvelopePath(envelope, 'envelope.event.update.self')
  })

  it('rejects an array property outside its canonical index range', () => {
    const input: unknown[] = []
    Object.defineProperty(input, '4294967295', {
      value: 'out-of-range',
      configurable: true,
      enumerable: true,
    })
    const envelope = fixtureEnvelope(4)
    ;(envelope.event as Record<string, unknown>).input = input

    expectEnvelopePath(envelope, 'envelope.event.input.4294967295')
  })

  it('rejects explicit undefined in optional JSON fields', () => {
    const toolCompleted = fixtureEnvelope(6)
    ;(toolCompleted.event as Record<string, unknown>).result = undefined
    expectEnvelopePath(toolCompleted, 'envelope.event.result')

    const permission = fixtureEnvelope(7)
    const request = (permission.event as Record<string, unknown>)
      .request as Record<string, unknown>
    request.inputSummary = undefined
    expectEnvelopePath(permission, 'envelope.event.request.inputSummary')
  })

  it('strictly validates RuntimeError in run_failed', () => {
    const structured = fixtureEnvelope(12)
    ;((structured.event as Record<string, unknown>).error as Record<
      string,
      unknown
    >) = {
      code: 'security_denied',
      message: 'capability denied',
      recoverable: false,
      details: { capability: 'terminal.execute' },
    }
    expect(parseRuntimeEventEnvelope(structured)).toEqual(structured)

    const invalidCode = fixtureEnvelope(12)
    const invalidCodeError = (invalidCode.event as Record<string, unknown>)
      .error as Record<string, unknown>
    invalidCodeError.code = 'unknown'
    expectEnvelopePath(invalidCode, 'envelope.event.error.code')

    const invalidRecoverable = fixtureEnvelope(12)
    const invalidRecoverableError = (
      invalidRecoverable.event as Record<string, unknown>
    ).error as Record<string, unknown>
    invalidRecoverableError.recoverable = 'yes'
    expectEnvelopePath(invalidRecoverable, 'envelope.event.error.recoverable')

    const unknownField = fixtureEnvelope(12)
    const unknownFieldError = (unknownField.event as Record<string, unknown>)
      .error as Record<string, unknown>
    unknownFieldError.details = 'secret'
    expectEnvelopePath(unknownField, 'envelope.event.error.details')
  })
})

describe('isTerminalRuntimeEvent', () => {
  it('only recognizes completed, cancelled, and failed events as terminal', () => {
    const parsed = fixture.map(parseRuntimeEventEnvelope)
    const terminalTypes = parsed
      .filter(({ event }) => isTerminalRuntimeEvent(event))
      .map(({ event }) => event.type)

    expect(terminalTypes).toEqual([
      'run_completed',
      'run_cancelled',
      'run_failed',
    ])
  })
})

describe('parseRuntimeSnapshot', () => {
  const snapshot = {
    runtimeId: 'hermes',
    status: 'ready',
    runtimeEpoch: 'epoch-1',
    sequence: 2,
  }

  it('accepts a strict Hermes runtime snapshot', () => {
    expect(parseRuntimeSnapshot(snapshot)).toEqual(snapshot)
  })

  it('accepts a strict Bianbu runtime snapshot', () => {
    expect(parseRuntimeSnapshot({ ...snapshot, runtimeId: 'bianbu' })).toEqual({
      ...snapshot,
      runtimeId: 'bianbu',
    })
  })

  it.each([
    ['runtimeId', 'unknown'],
    ['status', 'unknown'],
    ['runtimeEpoch', ''],
    ['sequence', -1],
    ['message', null],
  ])('rejects invalid snapshot field %s', (field, value) => {
    expect(() => parseRuntimeSnapshot({ ...snapshot, [field]: value })).toThrow(
      `snapshot.${field}`
    )
  })

  it('rejects unknown and explicitly undefined optional fields', () => {
    expect(() => parseRuntimeSnapshot({ ...snapshot, extra: true })).toThrow(
      'snapshot.extra'
    )
    expect(() =>
      parseRuntimeSnapshot({ ...snapshot, message: undefined })
    ).toThrow('snapshot.message')
  })
})

describe('runtime command response parsers', () => {
  it('parses strict session-create results', () => {
    const result = {
      sessionId: 'thread-1',
      runtimeSessionId: 'hermes-session-1',
      runtimeEpoch: 'epoch-1',
      reused: false,
    }
    expect(parseSessionCreateResult(result)).toEqual(result)
    expect(() =>
      parseSessionCreateResult({ ...result, sessionId: '' })
    ).toThrow('sessionCreateResult.sessionId')
    expect(() => parseSessionCreateResult({ ...result, cwd: '/tmp' })).toThrow(
      'sessionCreateResult.cwd'
    )
  })

  it('parses strict run-start results', () => {
    expect(parseRunStartResult({ runId: 'run-1' })).toEqual({ runId: 'run-1' })
    expect(() => parseRunStartResult({ runId: '' })).toThrow(
      'runStartResult.runId'
    )
    expect(() => parseRunStartResult({ runId: 'run-1', extra: true })).toThrow(
      'runStartResult.extra'
    )
  })

  it('rejects an inherited DTO field when its own field is missing', () => {
    Object.defineProperty(Object.prototype, 'runId', {
      value: 'inherited-run',
      configurable: true,
      enumerable: false,
    })

    try {
      expect(() => parseRunStartResult({})).toThrow('runStartResult.runId')
    } finally {
      delete (Object.prototype as Record<string, unknown>).runId
    }
  })

  it('parses strict command acknowledgements', () => {
    const ack = { accepted: true, duplicate: false }
    expect(parseCommandAck(ack)).toEqual(ack)
    expect(() => parseCommandAck({ ...ack, duplicate: 0 })).toThrow(
      'commandAck.duplicate'
    )
    expect(() => parseCommandAck({ ...ack, extra: true })).toThrow(
      'commandAck.extra'
    )
  })

  it('parses strict permission decision receipts with complete identity', () => {
    const receipt = {
      version: 1,
      runtimeInstanceId: 'hermes:epoch-1',
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      runId: 'run-1',
      requestId: 'permission-1',
      toolCallId: 'tool-1',
      decision: 'allow_once',
      status: 'accepted',
    }
    expect(parsePermissionDecisionReceipt(receipt)).toEqual(receipt)
    expect(() =>
      parsePermissionDecisionReceipt({ ...receipt, status: 'always' })
    ).toThrow('permissionDecisionReceipt.status')
    expect(() =>
      parsePermissionDecisionReceipt({ ...receipt, extra: true })
    ).toThrow('permissionDecisionReceipt.extra')
    expect(() =>
      parsePermissionDecisionReceipt({ ...receipt, actionSetDigest: 'deadbeef' })
    ).toThrow('permissionDecisionReceipt.actionSetDigest')
    expect(() =>
      parsePermissionDecisionReceipt({ ...receipt, reason: 'unknown' })
    ).toThrow('permissionDecisionReceipt.reason')
  })
})

describe('formatRuntimeCommandError', () => {
  it('preserves plain and native error messages', () => {
    expect(formatRuntimeCommandError('停止失败')).toBe('停止失败')
    expect(formatRuntimeCommandError(new Error('连接失败'))).toBe('连接失败')
  })
  it('formats only a strict RuntimeError', () => {
    expect(
      formatRuntimeCommandError({
        code: 'hermes_not_found',
        message: 'Hermes is not installed',
        recoverable: true,
      })
    ).toBe('hermes_not_found: Hermes is not installed')
  })

  it('preserves unavailable Skill code and identifiers', () => {
    expect(
      formatRuntimeCommandError({
        code: 'skill_unavailable',
        message: 'Skill is unavailable',
        recoverable: false,
        details: { skill_ids: ['vendor.review/code-review'] },
      })
    ).toBe('skill_unavailable: Skill is unavailable')
  })

  it.each([
    [null],
    [{ code: 'unknown', message: 'failed', recoverable: true }],
    [{ code: 'run_failed', message: 'failed', recoverable: 'yes' }],
    [
      {
        code: 'run_failed',
        message: 'failed',
        recoverable: true,
        details: 'unexpected',
      },
    ],
  ])('uses a stable fallback for invalid error values', (value) => {
    expect(formatRuntimeCommandError(value)).toBe('Runtime command failed')
  })
})

describe('describeRuntimeCommandError', () => {
  it('drops the machine code prefix from a RuntimeError', () => {
    expect(
      describeRuntimeCommandError({
        code: 'controller_busy',
        message: 'Bibit 命令行正在使用工作台。',
        recoverable: true,
      })
    ).toBe('Bibit 命令行正在使用工作台。')
  })

  it('keeps plain and native messages untouched', () => {
    expect(describeRuntimeCommandError('停止失败')).toBe('停止失败')
    expect(describeRuntimeCommandError(new Error('Something: failed'))).toBe('Something: failed')
  })
})
