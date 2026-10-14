import { create } from 'zustand'

type SettingsNavigationState = {
  origin: string | null
  setOrigin: (origin: string) => void
}

export const useSettingsNavigation = create<SettingsNavigationState>()((set) => ({
  origin: null,
  setOrigin: (origin) => set({ origin }),
}))
