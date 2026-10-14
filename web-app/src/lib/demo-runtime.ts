import type { UIMessage } from 'ai'
import type { KnowledgeContext } from './knowledge-retrieval'

export type DemoRuntimeMode = 'fixed' | 'streaming'

export type DemoRuntimeRequest = {
  sessionId: string
  prompt: string
  mode: DemoRuntimeMode
}

export type DemoConversationRequest = DemoRuntimeRequest & {
  userMessageId: string
}

type DemoRuntimeEventBase = {
  runId: string
  sessionId: string
  sequence: number
}

export type DemoRuntimeEvent =
  | (DemoRuntimeEventBase & { type: 'run_started' })
  | (DemoRuntimeEventBase & { type: 'message_delta'; delta: string })
  | (DemoRuntimeEventBase & {
      type: 'message_completed'
      content: string
    })
  | (DemoRuntimeEventBase & { type: 'run_cancelled' })
  | (DemoRuntimeEventBase & { type: 'run_failed'; message: string })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function isDemoRuntimeEvent(value: unknown): value is DemoRuntimeEvent {
  if (!isRecord(value)) return false
  if (
    typeof value.runId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.sequence !== 'number' ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 0
  ) {
    return false
  }

  switch (value.type) {
    case 'run_started':
    case 'run_cancelled':
      return true
    case 'message_delta':
      return typeof value.delta === 'string'
    case 'message_completed':
      return typeof value.content === 'string'
    case 'run_failed':
      return typeof value.message === 'string'
    default:
      return false
  }
}

export function isTerminalDemoRuntimeEvent(event: DemoRuntimeEvent): boolean {
  return (
    event.type === 'message_completed' ||
    event.type === 'run_cancelled' ||
    event.type === 'run_failed'
  )
}

export function extractLatestUserPrompt(messages: UIMessage[]): string {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
  const prompt = latestUserMessage?.parts
    .filter(
      (part): part is Extract<(typeof latestUserMessage.parts)[number], { type: 'text' }> =>
        part.type === 'text'
    )
    .map((part) => part.text)
    .join('')
    .trim()

  if (!prompt) throw new Error('消息不能为空')
  return prompt
}

export function extractLatestUserMessage(messages: UIMessage[]): {
  id: string
  prompt: string
  knowledgeContext?: KnowledgeContext
} {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
  const prompt = latestUserMessage?.parts
    .filter(
      (part): part is Extract<(typeof latestUserMessage.parts)[number], { type: 'text' }> =>
        part.type === 'text'
    )
    .map((part) => part.text)
    .join('')
    .trim()

  if (!prompt) throw new Error('消息不能为空')
  if (!latestUserMessage?.id) throw new Error('用户消息缺少标识')
  return { id: latestUserMessage.id, prompt, knowledgeContext: (latestUserMessage.metadata as { knowledgeContext?: KnowledgeContext } | undefined)?.knowledgeContext }
}
