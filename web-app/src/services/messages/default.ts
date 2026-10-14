/**
 * Default Messages Service - Web implementation
 */

import { ExtensionManager } from '@/lib/extension'
import {
  ContentType,
  ConversationalExtension,
  ExtensionTypeEnum,
  MessageStatus,
  ThreadMessage,
} from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import type { MessagesService } from './types'
import { invoke } from '@tauri-apps/api/core'
import type {
  RuntimeId,
  RuntimeMessage,
  RuntimeToolData,
} from '@/lib/runtime-contract'
import type { RuntimeTurnV2 } from '@/lib/messages'
import { useRuntimeStore } from '@/stores/runtime-store'

function runtimeTurn(
  runtimeId: RuntimeId,
  role: string,
  content: string,
  reasoning: unknown,
  toolCalls: unknown
): RuntimeTurnV2 | undefined {
  if (role !== 'assistant') return undefined
  const items: RuntimeTurnV2['items'] = []
  if (typeof reasoning === 'string' && reasoning) {
    items.push({ kind: 'reasoning', lane: 'work', markdown: reasoning })
  }
  for (const value of Array.isArray(toolCalls) ? toolCalls : []) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const call = value as Record<string, unknown>
    const toolCallId = String(call.call_id ?? '')
    const name = String(call.name ?? '')
    if (!toolCallId || !name) continue
    const rawStatus = String(call.status ?? '')
    const status: RuntimeToolData['status'] = ['success', 'completed'].includes(
      rawStatus
    )
      ? 'completed'
      : ['failed', 'error', 'rejected'].includes(rawStatus)
        ? 'failed'
        : rawStatus === 'running'
          ? 'running'
          : 'pending'
    items.push({
      kind: 'tool',
      lane: 'work',
      toolCallId,
      name,
      status,
      ...(call.arguments === undefined ? {} : { input: call.arguments }),
      ...(call.result === undefined ? {} : { result: call.result }),
      ...(status !== 'failed'
        ? {}
        : { error: String(call.reason ?? call.result ?? 'Tool failed') }),
    })
  }
  if (content) items.push({ kind: 'answer', lane: 'answer', markdown: content })
  return items.length
    ? { schemaVersion: 2, runtimeId, items }
    : undefined
}

function runtimeMessage(threadId: string, message: RuntimeMessage): ThreadMessage {
  const runtimeId = useRuntimeStore.getState().runtimeId ?? 'bianbu'
  const { id, role, content, requestId, createdAt, seq, ...extra } = message
  const { reasoning, tool_calls: toolCalls, ...metadataExtra } = extra
  const persistedTurn = runtimeTurn(runtimeId, role, content, reasoning, toolCalls)
  return {
    id,
    thread_id: threadId,
    object: 'thread.message',
    type: 'text',
    role: role as ThreadMessage['role'],
    content: [
      {
        type: ContentType.Text,
        text: { value: content, annotations: [] },
      },
    ],
    status: MessageStatus.Ready,
    created_at: createdAt ?? seq ?? 0,
    completed_at: createdAt ?? seq ?? 0,
    metadata: {
      runtime: runtimeId,
      requestId,
      ...metadataExtra,
      ...(persistedTurn ? { runtimeTurnV2: persistedTurn } : {}),
    },
  }
}

export class DefaultMessagesService implements MessagesService {
  private runtimeBacked() {
    const runtime = useRuntimeStore.getState()
    return runtime.capabilities?.durableSessions ?? false
  }

  async fetchMessages(threadId: string): Promise<ThreadMessage[]> {
    // Don't fetch messages from server for temporary chat - it's local only
    if (threadId === TEMPORARY_CHAT_ID) {
      return []
    }
    if (this.runtimeBacked()) {
      return (
        await invoke<RuntimeMessage[]>('runtime_messages_list', {
          sessionId: threadId,
        })
      ).map((message) => runtimeMessage(threadId, message))
    }

    return (
      ExtensionManager.getInstance()
        .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
        ?.listMessages(threadId)
        ?.catch(() => []) ?? []
    )
  }

  async createMessage(message: ThreadMessage): Promise<ThreadMessage> {
    // Don't create messages on server for temporary chat - it's local only
    if (message.thread_id === TEMPORARY_CHAT_ID) {
      return message
    }
    if (this.runtimeBacked()) return message

    return (
      ExtensionManager.getInstance()
        .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
        ?.createMessage(message)
        ?.catch(() => message) ?? message
    )
  }

  async modifyMessage(message: ThreadMessage): Promise<ThreadMessage> {
    // Don't modify messages on server for temporary chat - it's local only
    if (message.thread_id === TEMPORARY_CHAT_ID) {
      return message
    }
    if (this.runtimeBacked()) return message

    return (
      ExtensionManager.getInstance()
        .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
        ?.modifyMessage(message)
        ?.catch(() => message) ?? message
    )
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    // Don't delete messages on server for temporary chat - it's local only
    if (threadId === TEMPORARY_CHAT_ID) {
      return
    }
    if (this.runtimeBacked()) return

    await ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
      ?.deleteMessage(threadId, messageId)
  }
}
