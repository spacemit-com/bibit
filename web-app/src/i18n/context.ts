import { createContext } from "react"
import i18next from "./setup"

// Create context for translations
export const TranslationContext = createContext<{
	t: (key: string, options?: Record<string, unknown>) => string
	i18n: typeof i18next
}>({
	t: (key: string, options?: Record<string, unknown>) => i18next.t(key, options),
	i18n: i18next,
})
