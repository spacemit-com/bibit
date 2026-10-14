type LedgerEntry<TDecision> = {
  threadId?: string
  state: 'pending' | 'terminal'
  promise: Promise<TDecision>
  resolve: (decision: TDecision) => void
}

export interface PermissionRequestTicket<TDecision> {
  readonly promise: Promise<TDecision>
  readonly isNew: boolean
}

export const createPermissionRequestLedger = <TDecision,>() => {
  const entries = new Map<string, LedgerEntry<TDecision>>()

  const request = (
    requestId: string,
    threadId?: string
  ): PermissionRequestTicket<TDecision> => {
    const existing = entries.get(requestId)
    if (existing) return { promise: existing.promise, isNew: false }

    let resolve!: (decision: TDecision) => void
    const promise = new Promise<TDecision>((settle) => {
      resolve = settle
    })
    entries.set(requestId, { threadId, state: 'pending', promise, resolve })
    return { promise, isNew: true }
  }

  const decide = (requestId: string, decision: TDecision) => {
    const entry = entries.get(requestId)
    if (!entry || entry.state === 'terminal') return false
    entry.state = 'terminal'
    entry.resolve(decision)
    return true
  }

  const clearMatching = (
    predicate: (entry: LedgerEntry<TDecision>) => boolean,
    decision: TDecision
  ) => {
    let cleared = 0
    for (const [requestId, entry] of entries) {
      if (entry.state === 'pending' && predicate(entry)) {
        if (decide(requestId, decision)) cleared += 1
      }
    }
    return cleared
  }

  return {
    request,
    decide,
    state: (requestId: string) => entries.get(requestId)?.state,
    clearThread: (threadId: string, decision: TDecision) =>
      clearMatching((entry) => entry.threadId === threadId, decision),
    clear: (decision: TDecision) => clearMatching(() => true, decision),
    reset: () => entries.clear(),
  }
}
