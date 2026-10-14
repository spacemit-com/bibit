import { create } from 'zustand'
import { ThreadMessage } from '@janhq/core'
import { getServiceHub } from '@/hooks/useServiceHub'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

type MessageState = {
  messages: Record<string, ThreadMessage[]>
  getMessages: (threadId: string) => ThreadMessage[]
  setMessages: (threadId: string, messages: ThreadMessage[]) => void
  addMessage: (message: ThreadMessage) => void
  updateMessage: (message: ThreadMessage) => void
  deleteMessage: (threadId: string, messageId: string) => void
  upsertLocalMessage: (message: ThreadMessage) => void
  removeLocalMessage: (threadId: string, messageId: string) => void
  clearAllMessages: () => void
}

const originWindow = () => getCurrentWebviewWindow().label

const createPersistedMessage = (message: ThreadMessage) =>
  IS_TAURI
    ? invoke<ThreadMessage>('conversation_create_message', {
        originWindow: originWindow(),
        message,
      })
    : getServiceHub().messages().createMessage(message)

const updatePersistedMessage = (message: ThreadMessage) =>
  IS_TAURI
    ? invoke<ThreadMessage>('conversation_modify_message', {
        originWindow: originWindow(),
        message,
      })
    : getServiceHub().messages().modifyMessage(message)

const deletePersistedMessage = (threadId: string, messageId: string) =>
  IS_TAURI
    ? invoke<void>('conversation_delete_message', {
        originWindow: originWindow(),
        sessionId: threadId,
        messageId,
      })
    : getServiceHub().messages().deleteMessage(threadId, messageId)

const upsert = (messages: ThreadMessage[], message: ThreadMessage) => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) return [...messages, message]
  const next = [...messages]
  next[index] = message
  return next
}

export const useMessages = create<MessageState>()((set, get) => ({
  messages: {},
  getMessages: (threadId) => {
    return get().messages[threadId] || []
  },
  setMessages: (threadId, messages) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [threadId]: messages,
      },
    }))
  },
  addMessage: (message) => {
    const newMessage = {
      ...message,
      created_at: message.created_at || Date.now(),
    }

    // Optimistically update state immediately for instant UI feedback
    set((state) => ({
      messages: {
        ...state.messages,
        [message.thread_id]: upsert(
          state.messages[message.thread_id] || [],
          newMessage
        ),
      },
    }))

    // Persist to storage asynchronously
    createPersistedMessage(newMessage).then((createdMessage) => {
      set((state) => ({
        messages: {
          ...state.messages,
          [message.thread_id]: upsert(
            state.messages[message.thread_id] || [],
            createdMessage
          ),
        },
      }))
    }).catch((error) => {
      console.error('Failed to persist message:', error)
    })
  },
  updateMessage: (message) => {
    const updatedMessage = {
      ...message,
    }

    // Optimistically update state immediately for instant UI feedback
    set((state) => ({
      messages: {
        ...state.messages,
        [message.thread_id]: (state.messages[message.thread_id] || []).map((m) =>
          m.id === message.id ? updatedMessage : m
        ),
      },
    }))

    // Persist to storage asynchronously using modifyMessage instead of createMessage
    // to prevent duplicates when updating existing messages
    updatePersistedMessage(updatedMessage).catch((error) => {
      console.error('Failed to persist message update:', error)
    })
  },
  deleteMessage: (threadId, messageId) => {
    void deletePersistedMessage(threadId, messageId)
    set((state) => ({
      messages: {
        ...state.messages,
        [threadId]:
          state.messages[threadId]?.filter(
            (message) => message.id !== messageId
          ) || [],
      },
    }))
  },
  upsertLocalMessage: (message) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [message.thread_id]: upsert(
          state.messages[message.thread_id] || [],
          message
        ),
      },
    }))
  },
  removeLocalMessage: (threadId, messageId) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [threadId]: (state.messages[threadId] || []).filter(
          (message) => message.id !== messageId
        ),
      },
    }))
  },
  clearAllMessages: () => {
    set({ messages: {} })
  },
}))
