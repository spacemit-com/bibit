import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { DemoRuntimeMode } from '@/lib/demo-runtime'

type DemoRuntimeState = {
  enabled: true
  mode: DemoRuntimeMode
  setMode: (mode: DemoRuntimeMode) => void
}

export const useDemoRuntimeStore = create<DemoRuntimeState>()(
  persist(
    (set) => ({
      enabled: true,
      mode: 'streaming',
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'bibit-demo-runtime',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ mode: state.mode }),
    }
  )
)
