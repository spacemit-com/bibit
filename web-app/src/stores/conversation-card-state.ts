import { create } from 'zustand'
import type { RuntimeCardIdentity } from '@/lib/messages'

export type ConversationCardScope = { targetId?: string; runtimeId: string; sessionId: string }
type OpenCard = { scope: ConversationCardScope; card: RuntimeCardIdentity }

function matches(entry: OpenCard, scope: ConversationCardScope, card: RuntimeCardIdentity) {
  return entry.scope.targetId === scope.targetId && entry.scope.runtimeId === scope.runtimeId &&
    entry.scope.sessionId === scope.sessionId && entry.card.runId === card.runId && entry.card.kind === card.kind &&
    // A group and a thought both migrate by source anchor: a page that prepends
    // earlier events may renumber the first source, but the events it already
    // contained are still in the group.
    (card.kind === 'reasoning' || card.kind === 'group'
      ? entry.card.sourceSeqs.some(seq => card.sourceSeqs.includes(seq))
      : entry.card.id === card.id)
}

export const isCardExpanded = (opened: readonly OpenCard[], scope: ConversationCardScope, card: RuntimeCardIdentity) =>
  opened.some(entry => matches(entry, scope, card))

/** Window-local reading preferences; no content or approval decisions are persisted. */
export const useConversationCardState = create<{
  opened: OpenCard[]
  setExpanded: (scope: ConversationCardScope, card: RuntimeCardIdentity, open: boolean) => void
  clearSession: (sessionId: string, targetId?: string) => void
}>((set) => ({
  opened: [],
  setExpanded: (scope, card, open) => set(state => {
    const opened = state.opened.filter(entry => !matches(entry, scope, card))
    if (!open && opened.length === state.opened.length) return state
    // Retain an immutable source anchor, even if history prepends the same thought.
    if (open) opened.push({ scope: { ...scope }, card: { ...card, sourceSeqs: card.sourceSeqs.slice(0, 1) } })
    return { opened }
  }),
  clearSession: (sessionId, targetId) => set(state => {
    const opened = state.opened.filter(entry => entry.scope.sessionId !== sessionId || entry.scope.targetId !== targetId)
    return opened.length === state.opened.length ? state : { opened }
  }),
}))
