import type { KnowledgeContext } from './knowledge-retrieval'

/** 本机展示附件；服务端正文仍是会话历史的权威来源。 */
export type SessionKnowledge = {
  version: 1
  originalInput: string
  question: string
  prompt: string
  context: KnowledgeContext
}
const key = (target: string, session: string, message: string) =>
  `bibit:session-knowledge:${JSON.stringify([target, session, message])}`

/** 原始存储值：调用方用它当缓存键，命中时就不必再解析 JSON。 */
export function sessionKnowledgeRaw(target: string, session: string, message: string): string | null {
  try { return localStorage.getItem(key(target, session, message)) } catch { return null }
}

export function readSessionKnowledge(target: string, session: string, message: string, prompt?: string): SessionKnowledge | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key(target, session, message)) ?? 'null')
    if (value?.version !== 1 || typeof value.originalInput !== 'string' || typeof value.question !== 'string'
      || typeof value.prompt !== 'string' || (prompt !== undefined && value.prompt !== prompt)) return
    const context = value.context
    if (context?.type !== 'knowledge_retrieval' || !['succeeded', 'empty'].includes(context.status)
      || !Array.isArray(context.chunks)
      || !context.chunks.every((chunk: Record<string, unknown>) => chunk && typeof chunk.id === 'string'
        && typeof chunk.content === 'string' && typeof chunk.documentName === 'string' && typeof chunk.similarity === 'number')) return
    return value
  } catch { return undefined }
}

export function saveSessionKnowledge(target: string, session: string, message: string, value: SessionKnowledge): void {
  // 配额/权限错误必须阻止提交，避免显示信息在发送前已丢失。
  localStorage.setItem(key(target, session, message), JSON.stringify(value))
}
