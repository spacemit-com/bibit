import { beforeEach, expect, it } from 'vitest'
import { useConversationCardState, isCardExpanded } from '../conversation-card-state'

const scope = { targetId: 'target', runtimeId: 'bianbu', sessionId: 'session' }
const thought = { runId: 'run', kind: 'reasoning' as const, id: '100', sourceSeqs: [100, 101] }
beforeEach(() => useConversationCardState.setState({ opened: [] }))

it('preserves an expanded thought when earlier events change its canonical start', () => {
  const store = useConversationCardState.getState()
  expect(isCardExpanded(store.opened, scope, thought)).toBe(false)
  store.setExpanded(scope, thought, true)
  const older = { ...thought, id: '90', sourceSeqs: [90, 99, 100, 101, 102] }
  expect(isCardExpanded(useConversationCardState.getState().opened, scope, older)).toBe(true)
  store.setExpanded(scope, older, false)
  expect(isCardExpanded(useConversationCardState.getState().opened, scope, thought)).toBe(false)
})

it('isolates runs, sessions and targets and clears only the deleted session scope', () => {
  const store = useConversationCardState.getState()
  store.setExpanded(scope, thought, true)
  const otherTarget = { ...scope, targetId: 'other' }
  expect(isCardExpanded(useConversationCardState.getState().opened, otherTarget, thought)).toBe(false)
  expect(isCardExpanded(useConversationCardState.getState().opened, scope, { ...thought, runId: 'other' })).toBe(false)
  store.setExpanded(otherTarget, thought, true)
  store.clearSession('session', 'target')
  expect(isCardExpanded(useConversationCardState.getState().opened, scope, thought)).toBe(false)
  expect(isCardExpanded(useConversationCardState.getState().opened, otherTarget, thought)).toBe(true)
})

it('retains independent tools and clears all merged thought anchors on close', () => {
  const store = useConversationCardState.getState()
  store.setExpanded(scope, thought, true)
  store.setExpanded(scope, { ...thought, id: '103', sourceSeqs: [103] }, true)
  const tool = { ...thought, kind: 'tool' as const, id: 'call' }
  store.setExpanded(scope, tool, true)
  store.setExpanded(scope, { ...thought, sourceSeqs: [100, 101, 103] }, false)
  expect(useConversationCardState.getState().opened).toHaveLength(1)
  expect(isCardExpanded(useConversationCardState.getState().opened, scope, tool)).toBe(true)
})
