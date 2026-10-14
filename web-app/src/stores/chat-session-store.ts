/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import type { Chat, UIMessage } from "@ai-sdk/react";
import type { ChatStatus } from "ai";
import type { ThreadMessage } from '@janhq/core'
import { CustomChatTransport } from "@/lib/custom-chat-transport";
import { DemoChatTransport } from "@/lib/demo-chat-transport";
import { RuntimeChatTransport } from '@/lib/runtime-chat-transport'
import { useMessageQueue } from "@/stores/message-queue-store";
import type { DemoRuntimeEvent } from '@/lib/demo-runtime'
import {
  RUNTIME_ID,
  RUNTIME_SESSION_ID,
  type RuntimeEventEnvelope,
} from '@/lib/runtime-contract'
import {
  applyRuntimeEvent,
  applyRuntimeEnvelope,
  type RuntimeProjection,
} from '@/lib/conversation-sync'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'

export type SessionData = {
  tools: any[];
  messages: UIMessage[];
  idMap: Map<string, string>;
};

export type AppChatTransport =
  | CustomChatTransport
  | DemoChatTransport
  | RuntimeChatTransport

export type ChatSession = {
  chat: Chat<UIMessage>;
  transport: AppChatTransport;
  status: ChatStatus;
  title?: string;
  isStreaming: boolean;
  unsubscribers: Array<() => void>;
  data: SessionData;
};

interface ChatSessionState {
  sessions: Record<string, ChatSession>;
  activeConversationId?: string;
  mirroredRuns: Record<string, RuntimeProjection>;
  setActiveConversationId: (conversationId?: string) => void;
  ensureSession: (
    sessionId: string,
    transport: AppChatTransport,
    createChat: () => Chat<UIMessage>,
    title?: string,
  ) => Chat<UIMessage>;
  getSessionData: (sessionId: string) => SessionData;
  updateStatus: (sessionId: string, status: ChatStatus) => void;
  setSessionTitle: (sessionId: string, title?: string) => void;
  removeSession: (sessionId: string) => void;
  clearSessions: () => void;
  syncPersistentMessage: (sessionId: string, message: ThreadMessage) => void;
  syncMirroredRuntimeProjection: (projection: RuntimeProjection) => void;
  clearMirroredRuntimeProjection: (sessionId: string) => void;
  applyMirroredRuntimeEvent: (event: DemoRuntimeEvent) => void;
  applyMirroredRuntimeEnvelope: (event: RuntimeEventEnvelope) => void;
}

const STREAMING_STATUSES: ChatStatus[] = [
  'submitted',
  'streaming',
];

// Pure helper function for checking if a session is busy (for reactive use in components)
export function isSessionBusy(session: ChatSession | undefined): boolean {
  return session?.isStreaming || (session?.data?.tools?.length ?? 0) > 0;
}

const createSessionData = (): SessionData => ({
  tools: [],
  messages: [],
  idMap: new Map<string, string>(),
});

// Standalone data store for sessions that don't have a Chat yet
const standaloneData: Record<string, SessionData> = {};

const runtimeMessage = (projection: RuntimeProjection): UIMessage => ({
  id: projection.runId,
  role: 'assistant',
  parts: projection.content
    ? [{ type: 'text', text: projection.content }]
    : [],
  metadata: { runtime: projection.runtimeId ?? RUNTIME_ID, mirrored: true },
})

function extractUIMessageText(msg: UIMessage): string {
  return (msg.parts || [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim()
}

function uiMessagesMatch(candidate: UIMessage, message: UIMessage): boolean {
  if (candidate.id === message.id) return true
  if (candidate.role !== message.role) return false

  if (candidate.role === 'user') {
    const candidateText = extractUIMessageText(candidate)
    const messageText = extractUIMessageText(message)
    if (candidateText && messageText && candidateText === messageText) {
      return true
    }
  } else if (candidate.role === 'assistant') {
    const candidateMeta = candidate.metadata as Record<string, unknown> | undefined
    const messageMeta = message.metadata as Record<string, unknown> | undefined
    const candidateReqId =
      typeof candidateMeta?.requestId === 'string'
        ? candidateMeta.requestId
        : candidate.id
    const messageReqId =
      typeof messageMeta?.requestId === 'string'
        ? messageMeta.requestId
        : message.id

    if (
      candidateReqId &&
      messageReqId &&
      (candidateReqId === messageReqId ||
        candidateReqId === message.id ||
        messageReqId === candidate.id)
    ) {
      return true
    }
  }

  return false
}

const upsertUIMessage = (
  messages: UIMessage[],
  message: UIMessage
): UIMessage[] => {
  const index = messages.findIndex((candidate) => uiMessagesMatch(candidate, message))
  if (index < 0) return [...messages, message]
  const next = [...messages]
  const existing = next[index]
  const hasParts =
    (message.parts?.length ?? 0) > 0 &&
    message.parts.some((p) => {
      if (p.type === 'text') return Boolean(p.text)
      if (p.type === 'reasoning') return Boolean(p.text || (p as any).reasoning)
      return true
    })
  next[index] = {
    ...existing,
    ...message,
    parts: hasParts ? message.parts : existing.parts,
    metadata: {
      ...((existing.metadata as Record<string, unknown> | undefined) || {}),
      ...((message.metadata as Record<string, unknown> | undefined) || {}),
    },
  }
  return next
}

export const useChatSessions = create<ChatSessionState>((set, get) => ({
  sessions: {},
  activeConversationId: undefined,
  mirroredRuns: {},
  setActiveConversationId: (conversationId) =>
    set({ activeConversationId: conversationId }),
  ensureSession: (sessionId, transport, createChat, title) => {
    // Only update activeConversationId if it changed (avoid unnecessary state updates during render)
    if (get().activeConversationId !== sessionId) {
      set({ activeConversationId: sessionId });
    }

    const existing = get().sessions[sessionId];
    if (existing) {
      // Keep transport and title in sync if they changed
      if (existing.transport !== transport || existing.title !== title) {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...existing,
              transport,
              title: title ?? existing.title,
            },
          },
        }));
      }
      return existing.chat;
    }

    const chat = createChat();
    const syncStatus = () => {
      get().updateStatus(sessionId, chat.status);
    };
    const unsubscribeStatus = chat["~registerStatusCallback"]
      ? chat["~registerStatusCallback"](syncStatus)
      : undefined;

    // Use existing standalone data if available, otherwise create new
    const data = standaloneData[sessionId] ?? createSessionData();
    delete standaloneData[sessionId]; // Move to session

    const mirroredRun = get().mirroredRuns[sessionId];
    if (mirroredRun) {
      chat.messages = upsertUIMessage(chat.messages, runtimeMessage(mirroredRun));
    }

    const newSession: ChatSession = {
      chat,
      transport,
      status: mirroredRun ? 'streaming' : chat.status,
      title,
      isStreaming: Boolean(mirroredRun) || STREAMING_STATUSES.includes(chat.status),
      unsubscribers: unsubscribeStatus ? [unsubscribeStatus] : [],
      data,
    };

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: newSession,
      },
    }));

    return chat;
  },
  getSessionData: (sessionId) => {
    const existing = get().sessions[sessionId];
    if (existing) {
      return existing.data;
    }
    // Return or create standalone data for sessions without a Chat yet
    if (!standaloneData[sessionId]) {
      standaloneData[sessionId] = createSessionData();
    }
    return standaloneData[sessionId];
  },
  updateStatus: (sessionId, status) => {
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) {
        return state;
      }

      const wasStreaming = existing.isStreaming;
      const isStreaming = STREAMING_STATUSES.includes(status);
      if (existing.status === status && wasStreaming === isStreaming) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            status,
            isStreaming,
          },
        },
      };
    });
  },
  setSessionTitle: (sessionId, title) => {
    if (!title) return;

    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing || existing.title === title) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, title },
        },
      };
    });
  },
  removeSession: (sessionId) => {
    const existing = get().sessions[sessionId];
    if (!existing) {
      delete standaloneData[sessionId];
      set((state) => {
        if (!state.mirroredRuns[sessionId]) return state
        const mirroredRuns = { ...state.mirroredRuns }
        delete mirroredRuns[sessionId]
        return { mirroredRuns }
      })
      return;
    }

    // Clear any pending queued messages for this session
    useMessageQueue.getState().clearQueue(sessionId);

    // Remove from store FIRST so updateStatus callbacks during cleanup find nothing to update
    set((state) => {
      if (!state.sessions[sessionId]) {
        return state;
      }
      const rest = { ...state.sessions };
      delete rest[sessionId];
      return { sessions: rest };
    });

    // Then cleanup (existing is a copy, safe to use after removal)
    existing.unsubscribers.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        console.error("Failed to unsubscribe chat session listener", error);
      }
    });
    try {
      existing.chat.stop();
    } catch (error) {
      console.error("Failed to stop chat session", error);
    }

    delete standaloneData[sessionId];
    set((state) => {
      if (!state.mirroredRuns[sessionId]) return state
      const mirroredRuns = { ...state.mirroredRuns }
      delete mirroredRuns[sessionId]
      return { mirroredRuns }
    })
  },
  clearSessions: () => {
    const sessions = get().sessions;

    // Clear all queued messages
    Object.keys(sessions).forEach((sessionId) => {
      useMessageQueue.getState().clearQueue(sessionId);
    });

    Object.values(sessions).forEach((session) => {
      session.unsubscribers.forEach((unsubscribe) => {
        try {
          unsubscribe();
        } catch (error) {
          console.error("Failed to unsubscribe chat session listener", error);
        }
      });
      try {
        session.chat.stop();
      } catch (error) {
        console.error("Failed to stop chat session", error);
      }
    });

    // Clear standalone data
    Object.keys(standaloneData).forEach((key) => {
      delete standaloneData[key];
    });

    set({ sessions: {}, activeConversationId: undefined, mirroredRuns: {} });
  },
  syncPersistentMessage: (sessionId, message) => {
    const session = get().sessions[sessionId]
    if (!session) return
    const uiMessage = convertThreadMessagesToUIMessages([message])[0]
    if (!uiMessage) return
    session.chat.messages = upsertUIMessage(session.chat.messages, uiMessage)
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...session },
      },
    }))
  },
  syncMirroredRuntimeProjection: (projection) => {
    const session = get().sessions[projection.sessionId]
    if (session && STREAMING_STATUSES.includes(session.chat.status)) return
    if (session) {
      session.chat.messages = upsertUIMessage(
        session.chat.messages,
        runtimeMessage(projection)
      )
    }
    set((state) => ({
      mirroredRuns: {
        ...state.mirroredRuns,
        [projection.sessionId]: projection,
      },
      sessions: session
        ? {
            ...state.sessions,
            [projection.sessionId]: {
              ...session,
              status: 'streaming',
              isStreaming: true,
            },
          }
        : state.sessions,
    }))
  },
  clearMirroredRuntimeProjection: (sessionId) => {
    set((state) => {
      const mirroredRun = state.mirroredRuns[sessionId]
      const session = state.sessions[sessionId]
      if (!mirroredRun) return state

      const mirroredRuns = { ...state.mirroredRuns }
      delete mirroredRuns[sessionId]
      return {
        mirroredRuns,
        sessions: session
          ? {
              ...state.sessions,
              [sessionId]: {
                ...session,
                status: 'ready',
                isStreaming: false,
              },
            }
          : state.sessions,
      }
    })
  },
  applyMirroredRuntimeEvent: (event) => {
    const ownedSession = get().sessions[event.sessionId]
    if (ownedSession && STREAMING_STATUSES.includes(ownedSession.chat.status)) return
    const current = get().mirroredRuns[event.sessionId]
    const next = applyRuntimeEvent(current, event)
    if (next === current) return

    const session = get().sessions[event.sessionId]
    const isActivelyDriving = Boolean(
      (session?.transport as { isActivelyDriving?: (id: string) => boolean } | undefined)
        ?.isActivelyDriving?.(event.sessionId)
    )

    if (session && !isActivelyDriving) {
      if (next) {
        session.chat.messages = upsertUIMessage(
          session.chat.messages,
          runtimeMessage(next)
        )
      } else {
        const existing = session.chat.messages.find(
          (message) => message.id === event.runId
        )
        if (existing) {
          const content =
            event.type === 'message_completed'
              ? event.content
              : current?.content ?? ''
          session.chat.messages = upsertUIMessage(session.chat.messages, {
            ...existing,
            parts: content ? [{ type: 'text', text: content }] : existing.parts,
            metadata: {
              ...(existing.metadata as Record<string, unknown> | undefined),
              ...(event.type === 'run_cancelled' ? { stopped: true } : {}),
              ...(event.type === 'run_failed' ? { error: event.message } : {}),
            },
          })
        }
      }
    }

    set((state) => {
      const mirroredRuns = { ...state.mirroredRuns }
      if (next) mirroredRuns[event.sessionId] = next
      else delete mirroredRuns[event.sessionId]
      const existingSession = state.sessions[event.sessionId]
      if (isActivelyDriving) {
        return { mirroredRuns }
      }
      return {
        mirroredRuns,
        sessions: existingSession
          ? {
              ...state.sessions,
              [event.sessionId]: {
                ...existingSession,
                status: next ? 'streaming' : 'ready',
                isStreaming: Boolean(next),
              },
            }
          : state.sessions,
      }
    })
  },
  applyMirroredRuntimeEnvelope: (envelope) => {
    if (!envelope.runId || envelope.sessionId === RUNTIME_SESSION_ID) return
    const ownedSession = get().sessions[envelope.sessionId]
    if (ownedSession && STREAMING_STATUSES.includes(ownedSession.chat.status)) return
    const current = get().mirroredRuns[envelope.sessionId]
    const next = applyRuntimeEnvelope(current, envelope)
    if (next === current) return

    const session = get().sessions[envelope.sessionId]
    const isActivelyDriving = Boolean(
      (session?.transport as { isActivelyDriving?: (id: string) => boolean } | undefined)
        ?.isActivelyDriving?.(envelope.sessionId)
    )

    if (session && !isActivelyDriving) {
      if (next) {
        session.chat.messages = upsertUIMessage(
          session.chat.messages,
          runtimeMessage(next)
        )
      } else {
        const existing = session.chat.messages.find(
          (message) => message.id === envelope.runId
        )
        if (existing) {
          const content = current?.content ?? ''
          session.chat.messages = upsertUIMessage(session.chat.messages, {
            ...existing,
            parts: content ? [{ type: 'text', text: content }] : existing.parts,
            metadata: {
              ...(existing.metadata as Record<string, unknown> | undefined),
              ...(envelope.event.type === 'run_cancelled' ? { stopped: true } : {}),
              ...(envelope.event.type === 'run_failed'
                ? { error: envelope.event.error.message }
                : {}),
            },
          })
        }
      }
    }

    set((state) => {
      const mirroredRuns = { ...state.mirroredRuns }
      if (next) mirroredRuns[envelope.sessionId] = next
      else delete mirroredRuns[envelope.sessionId]
      const existingSession = state.sessions[envelope.sessionId]
      if (isActivelyDriving) {
        return { mirroredRuns }
      }
      return {
        mirroredRuns,
        sessions: existingSession
          ? {
              ...state.sessions,
              [envelope.sessionId]: {
                ...existingSession,
                status: next ? 'streaming' : 'ready',
                isStreaming: Boolean(next),
              },
            }
          : state.sessions,
      }
    })
  },
}));
