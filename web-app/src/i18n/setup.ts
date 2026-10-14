import { localStorageKey } from '@/constants/localStorage'
import {
  normalizeLanguage,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  type ResolvedLanguage,
  type SupportedLanguage,
} from './supportedLanguages'

// Types for our i18n implementation
export interface TranslationResources {
  [language: string]: {
    [namespace: string]: {
      [key: string]: unknown
    }
  }
}

export interface I18nInstance {
  language: string
  fallbackLng: string
  resources: TranslationResources
  namespaces: string[]
  defaultNS: string
  changeLanguage: (lng: string) => void
  t: (key: string, options?: Record<string, unknown>) => string
}

// Global i18n instance
let i18nInstance: I18nInstance

// Locale files stay behind import(): an eager glob pulls all 17 language trees
// into the entry chunk, which is ~1 MB of JSON parsed before first paint even
// though only the selectable languages can ever be shown. Languages outside
// SUPPORTED_LANGUAGES load on demand via loadLanguage().
const localeFiles = import.meta.glob<Record<string, unknown>>(
  '../locales/**/*.json'
)

const resources: TranslationResources = {}
const namespaces: string[] = []

const EAGER_LANGUAGES: ResolvedLanguage[] = Array.from(
  new Set<ResolvedLanguage>([
    'en',
    ...SUPPORTED_LANGUAGES.map(({ value }) => value).filter(
      (value): value is ResolvedLanguage => value !== 'system'
    ),
  ])
)

const loadedLanguages = new Set<string>()

const loadLanguage = async (language: string): Promise<void> => {
  if (loadedLanguages.has(language)) return
  loadedLanguages.add(language)
  const prefix = `../locales/${language}/`
  await Promise.all(
    Object.entries(localeFiles)
      .filter(([path]) => path.startsWith(prefix))
      .map(async ([path, load]) => {
        const namespace = path.slice(prefix.length).replace(/\.json$/, '')
        const module = (await load()) as { default?: unknown }
        resources[language] ??= {}
        resources[language][namespace] = (module.default ?? module) as Record<
          string,
          unknown
        >
        if (!namespaces.includes(namespace)) namespaces.push(namespace)
      })
  )
}

/** Load the locale trees the UI can select. Called before the first render. */
export const ensureLocalesLoaded = async (): Promise<void> => {
  await Promise.all(EAGER_LANGUAGES.map(loadLanguage))
}

const isLocaleResource = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const registerFeatureLocales = (
  featureId: string,
  locales: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): void => {
  const staged = Object.entries(locales)
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(featureId) ||
    staged.some(
      ([language, resource]) =>
        !/^[A-Za-z0-9-]+$/.test(language) || !isLocaleResource(resource)
    )
  ) {
    throw new Error('Invalid Feature locale resources')
  }
  const copies = staged.map(
    ([language, resource]) => [language, structuredClone(resource)] as const
  )
  for (const [language, resource] of copies) {
    resources[language] ??= {}
    resources[language][featureId] = resource
  }
  if (!namespaces.includes(featureId)) namespaces.push(featureId)
}

// Get stored language preference
const getStoredLanguage = (): SupportedLanguage => {
  try {
    const stored = localStorage.getItem(localStorageKey.settingGeneral)
    const parsed = stored ? JSON.parse(stored) : {}
    return normalizeLanguage(parsed?.state?.currentLanguage)
  } catch {
    return 'system'
  }
}

// Translation function
const translate = (
  key: string,
  options: Record<string, unknown> = {}
): string => {
  const { language, fallbackLng, resources: res, defaultNS } = i18nInstance

  // Parse key to extract namespace and actual key
  let namespace = defaultNS
  let translationKey = key

  if (key.includes(':')) {
    const parts = key.split(':')
    namespace = parts[0]
    translationKey = parts[1]
  }

  // Helper function to get nested value from object using dot notation
  const getNestedValue = (
    obj: Record<string, unknown>,
    path: string
  ): string | undefined => {
    return path.split('.').reduce((current, key) => {
      return current &&
        typeof current === 'object' &&
        current !== null &&
        key in current
        ? (current as Record<string, unknown>)[key]
        : undefined
    }, obj as unknown) as string | undefined
  }

  // Try to get translation from current language
  let translation = getNestedValue(res[language]?.[namespace], translationKey)

  // Fallback to fallback language if not found
  if (translation === undefined && language !== fallbackLng) {
    translation = getNestedValue(res[fallbackLng]?.[namespace], translationKey)
  }

  // If still not found, return the key itself
  if (translation === undefined) {
    console.warn(`Translation missing for key: ${key}`)
    return key
  }

  // Handle interpolation
  if (typeof translation === 'string' && options) {
    return translation.replace(/\{\{(\w+)\}\}/g, (match, variable) => {
      return options[variable] !== undefined ? String(options[variable]) : match
    })
  }

  return String(translation)
}

// Change language function
const changeLanguage = (lng: string): void => {
  const preference = normalizeLanguage(lng)
  const language = resolveLanguage(preference)
  if (i18nInstance && !resources[language]) void loadLanguage(language)
  if (i18nInstance) {
    i18nInstance.language = language
    // 屏幕阅读器与字体回退都读 <html lang>，它必须跟着界面语言走。
    document.documentElement.lang = language

    // Update localStorage
    try {
      const stored = localStorage.getItem(localStorageKey.settingGeneral)
      const parsed = stored ? JSON.parse(stored) : { state: {} }
      parsed.state.currentLanguage = preference
      localStorage.setItem(
        localStorageKey.settingGeneral,
        JSON.stringify(parsed)
      )
    } catch (error) {
      console.error('Failed to save language preference:', error)
    }
  }
}

// Initialize i18n instance
const initI18n = (): I18nInstance => {
  const currentLanguage = resolveLanguage(getStoredLanguage())

  i18nInstance = {
    language: currentLanguage,
    fallbackLng: 'en',
    resources,
    namespaces,
    defaultNS: 'common',
    changeLanguage,
    t: translate,
  }
  document.documentElement.lang = currentLanguage

  return i18nInstance
}

// Load translations function (for compatibility with reference implementation)
export const loadTranslations = (): void => {
  // Locale trees load on demand now; this stays as a compatibility shim.
  void ensureLocalesLoaded()
}

// Initialize and export the i18n instance
const i18n = initI18n()

export default i18n
