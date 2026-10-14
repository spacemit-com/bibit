import type { ThreadMessage } from '@janhq/core'
import type { DemoRuntimeEvent } from '@/lib/demo-runtime'
import {
  RUNTIME_SESSION_ID,
  parseRuntimeEventEnvelope,
  type RuntimeEventEnvelope,
  type RuntimeId,
} from '@/lib/runtime-contract'

export type RuntimeProjection = {
  runtimeId?: RuntimeId
  runId: string
  sessionId: string
  lastSequence: number
  content: string
  status: 'running'
}

export type ConversationEvent = (
  | {
      type: 'conversation.selected'
      cursor: number
      originWindow: string
      sessionId?: string | null
    }
  | {
      type: 'conversation.draft_changed'
      cursor: number
      originWindow: string
      sessionId: string
      draft: string
    }
  | {
      type: 'conversation.message_created'
      cursor: number
      originWindow: string
      message: ThreadMessage
    }
  | {
      type: 'conversation.message_updated'
      cursor: number
      originWindow: string
      message: ThreadMessage
    }
  | {
      type: 'conversation.message_deleted'
      cursor: number
      originWindow: string
      sessionId: string
      messageId: string
    }
  | {
      type: 'runtime.event'
      cursor: number
      originWindow: string
      event: RuntimeEventEnvelope
    }

) & { targetId?: string | null }

export type ConversationSnapshot = {
  targetId?: string | null
  cursor: number
  selectedSessionId?: string | null
  drafts: Record<string, string>
  messages: ThreadMessage[]
  activeRun?: RuntimeProjection | null
}

export type ConversationProjection = {
  targetId?: string | null
  cursor: number
  selectedSessionId?: string
  drafts: Record<string, string>
  messages: ThreadMessage[]
  activeRun?: RuntimeProjection
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isCursor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isThreadMessage = (value: unknown): value is ThreadMessage =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.thread_id === 'string'

const hasEventBase = (
  value: Record<string, unknown>
): value is Record<string, unknown> & {
  cursor: number
  originWindow: string
} => isCursor(value.cursor) && typeof value.originWindow === 'string'

export function isConversationEvent(value: unknown): value is ConversationEvent {
  if (!isRecord(value) || !hasEventBase(value)) return false

  switch (value.type) {
    case 'conversation.selected':
      return (
        value.sessionId === undefined ||
        value.sessionId === null ||
        typeof value.sessionId === 'string'
      )
    case 'conversation.draft_changed':
      return (
        typeof value.sessionId === 'string' && typeof value.draft === 'string'
      )
    case 'conversation.message_created':
    case 'conversation.message_updated':
      return isThreadMessage(value.message)
    case 'conversation.message_deleted':
      return (
        typeof value.sessionId === 'string' &&
        typeof value.messageId === 'string'
      )
    case 'runtime.event':
      try {
        parseRuntimeEventEnvelope(value.event)
        return true
      } catch {
        return false
      }
    default:
      return false
  }
}

export function upsertMessage(
  messages: ThreadMessage[],
  message: ThreadMessage
): ThreadMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) return [...messages, message]
  const next = [...messages]
  next[index] = message
  return next
}

export function applyRuntimeEvent(
  current: RuntimeProjection | undefined,
  event: DemoRuntimeEvent
): RuntimeProjection | undefined {
  if (event.type === 'run_started') {
    if (event.sequence !== 0) return current
    if (
      current?.runId === event.runId &&
      current.sessionId === event.sessionId
    ) {
      return current
    }
    return {
      runId: event.runId,
      sessionId: event.sessionId,
      lastSequence: 0,
      content: '',
      status: 'running',
    }
  }

  if (
    !current ||
    current.runId !== event.runId ||
    current.sessionId !== event.sessionId ||
    event.sequence !== current.lastSequence + 1
  ) {
    return current
  }

  if (event.type === 'message_delta') {
    return {
      ...current,
      lastSequence: event.sequence,
      content: current.content + event.delta,
    }
  }

  return undefined
}

export function applyRuntimeEnvelope(
  current: RuntimeProjection | undefined,
  envelope: RuntimeEventEnvelope
): RuntimeProjection | undefined {
  if (envelope.sessionId === RUNTIME_SESSION_ID || !envelope.runId) return current

  const { event } = envelope
  if (event.type === 'run_started') {
    if (envelope.sequence !== 0) return current
    if (
      current?.runId === envelope.runId &&
      current.sessionId === envelope.sessionId
    ) {
      return current
    }
    return {
      runtimeId: envelope.runtimeId,
      runId: envelope.runId,
      sessionId: envelope.sessionId,
      lastSequence: 0,
      content: '',
      status: 'running',
    }
  }

  if (
    !current ||
    current.runId !== envelope.runId ||
    current.sessionId !== envelope.sessionId ||
    envelope.sequence !== current.lastSequence + 1
  ) {
    return current
  }

  if (event.type === 'text_delta') {
    return {
      ...current,
      lastSequence: envelope.sequence,
      content: current.content + event.delta,
    }
  }

  if (
    event.type === 'run_completed' ||
    event.type === 'run_cancelled' ||
    event.type === 'run_failed'
  ) {
    return undefined
  }

  return {
    ...current,
    lastSequence: envelope.sequence,
  }
}

export function applyRuntimeEvents(
  initial: RuntimeProjection | undefined,
  events: DemoRuntimeEvent[]
): RuntimeProjection | undefined {
  return events.reduce<RuntimeProjection | undefined>(applyRuntimeEvent, initial)
}

function applyConversationEvent(
  projection: ConversationProjection,
  event: ConversationEvent
): ConversationProjection {
  if (event.cursor <= projection.cursor) return projection

  const next: ConversationProjection = { ...projection, cursor: event.cursor }
  switch (event.type) {
    case 'conversation.selected':
      next.selectedSessionId = event.sessionId ?? undefined
      return next
    case 'conversation.draft_changed':
      next.drafts = {
        ...projection.drafts,
        [event.sessionId]: event.draft,
      }
      return next
    case 'conversation.message_created':
    case 'conversation.message_updated':
      next.messages = upsertMessage(projection.messages, event.message)
      return next
    case 'conversation.message_deleted':
      next.messages = projection.messages.filter(
        (message) =>
          message.thread_id !== event.sessionId ||
          message.id !== event.messageId
      )
      return next
    case 'runtime.event':
      if (
        event.event.sessionId === projection.selectedSessionId ||
        event.event.sessionId === projection.activeRun?.sessionId
      ) {
        next.activeRun = applyRuntimeEnvelope(
          projection.activeRun,
          event.event
        )
      }
      return next
  }
}

export function reconcileSnapshot(
  snapshot: ConversationSnapshot,
  bufferedEvents: ConversationEvent[]
): ConversationProjection {
  const initial: ConversationProjection = {
    cursor: snapshot.cursor,
    targetId: snapshot.targetId,
    selectedSessionId: snapshot.selectedSessionId ?? undefined,
    drafts: { ...snapshot.drafts },
    messages: [...snapshot.messages],
    activeRun: snapshot.activeRun ?? undefined,
  }

  return [...bufferedEvents]
    .sort((left, right) => left.cursor - right.cursor)
    .reduce(applyConversationEvent, initial)
}
