export const SUPPORTED_LANGUAGES = [
  { value: 'system', label: 'System' },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['value']
export type ResolvedLanguage = Exclude<SupportedLanguage, 'system'>

export const normalizeLanguage = (value: unknown): SupportedLanguage =>
  SUPPORTED_LANGUAGES.some((language) => language.value === value)
    ? (value as SupportedLanguage)
    : 'system'

export const resolveLanguage = (
  preference: SupportedLanguage,
  systemLanguage = globalThis.navigator?.language ?? 'en'
): ResolvedLanguage => {
  if (preference !== 'system') return preference
  return systemLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}
