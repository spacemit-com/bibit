import { create } from 'zustand'
import {
  RUNTIME_SESSION_ID,
  type RuntimeCapabilities,
  type RuntimeDescriptor,
  type RuntimeEventEnvelope,
  type RuntimeId,
  type RuntimeSnapshot,
  type RuntimeStatus,
} from '@/lib/runtime-contract'

type RuntimeState = {
  enabled: boolean
  runtimeId?: RuntimeId
  status: RuntimeStatus
  runtimeEpoch?: string
  lastSequence: number
  message?: string
  retiredEpochs: Set<string>
  capabilities: RuntimeCapabilities
  availableRuntimes: RuntimeDescriptor[]
  applyEnvelope: (event: RuntimeEventEnvelope) => void
  applySnapshot: (snapshot: RuntimeSnapshot) => void
  applyCapabilities: (
    capabilities: RuntimeCapabilities,
    identity: Pick<RuntimeSnapshot, 'runtimeId' | 'runtimeEpoch'>
  ) => void
  applyAvailableRuntimes: (runtimes: RuntimeDescriptor[]) => void
}

const EMPTY_CAPABILITIES: RuntimeCapabilities = {
  durableSessions: false,
  detachedRuns: false,
  replayableEvents: false,
  runtimeOwnedApprovals: false,
}

const capabilitiesFor = (
  state: RuntimeState,
  identity: Pick<RuntimeSnapshot, 'runtimeId' | 'runtimeEpoch'>
) =>
  state.runtimeId === identity.runtimeId &&
  state.runtimeEpoch === identity.runtimeEpoch
    ? state.capabilities
    : (state.availableRuntimes.find((runtime) => runtime.id === identity.runtimeId)
        ?.capabilities ?? EMPTY_CAPABILITIES)

export const RUNTIME_ENABLED = true

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  enabled: RUNTIME_ENABLED,
  runtimeId: 'bianbu',
  status: 'stopped',
  lastSequence: -1,
  retiredEpochs: new Set(),
  capabilities: {
    durableSessions: true,
    detachedRuns: true,
    replayableEvents: true,
    runtimeOwnedApprovals: true,
  },
  availableRuntimes: [],
  applyEnvelope: (envelope) => {
    if (
      envelope.sessionId !== RUNTIME_SESSION_ID ||
      envelope.event.type !== 'runtime_status_changed'
    ) {
      return
    }

    const state = get()
    if (state.retiredEpochs.has(envelope.runtimeEpoch)) return
    if (
      state.runtimeEpoch === envelope.runtimeEpoch &&
      envelope.sequence <= state.lastSequence
    ) {
      return
    }

    const retiredEpochs = new Set(state.retiredEpochs)
    if (state.runtimeEpoch && state.runtimeEpoch !== envelope.runtimeEpoch) {
      retiredEpochs.add(state.runtimeEpoch)
    }

    set({
      runtimeId: envelope.runtimeId,
      capabilities: capabilitiesFor(state, envelope),
      status: envelope.event.status,
      runtimeEpoch: envelope.runtimeEpoch,
      lastSequence: envelope.sequence,
      message: envelope.event.message,
      retiredEpochs,
    })
  },
  applySnapshot: (snapshot) => {
    const state = get()
    if (
      snapshot.runtimeEpoch &&
      state.retiredEpochs.has(snapshot.runtimeEpoch)
    ) {
      return
    }
    if (
      snapshot.runtimeEpoch === state.runtimeEpoch &&
      snapshot.sequence < state.lastSequence
    ) {
      return
    }

    const retiredEpochs = new Set(state.retiredEpochs)
    if (
      state.runtimeEpoch &&
      snapshot.runtimeEpoch &&
      state.runtimeEpoch !== snapshot.runtimeEpoch
    ) {
      retiredEpochs.add(state.runtimeEpoch)
    }

    set({
      runtimeId: snapshot.runtimeId,
      capabilities: capabilitiesFor(state, snapshot),
      status: snapshot.status,
      runtimeEpoch: snapshot.runtimeEpoch,
      lastSequence: snapshot.sequence,
      message: snapshot.message,
      retiredEpochs,
    })
  },
  applyCapabilities: (capabilities, identity) => {
    const state = get()
    if (
      state.runtimeId !== identity.runtimeId ||
      state.runtimeEpoch !== identity.runtimeEpoch
    ) return
    set({ capabilities })
  },
  applyAvailableRuntimes: (availableRuntimes) => {
    const state = get()
    set({
      availableRuntimes,
      capabilities:
        availableRuntimes.find((runtime) => runtime.id === state.runtimeId)
          ?.capabilities ?? state.capabilities,
    })
  },
}))
