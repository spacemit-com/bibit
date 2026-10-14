import i18n from '@/i18n/setup'

type FormatDateOptions = {
  includeTime?: boolean
  /** BCP-47 语言标签；默认跟随界面当前语言。 */
  locale?: string
}

export const formatDate = (
  date: string | number | Date,
  options?: FormatDateOptions
): string => {
  const includeTime = options?.includeTime ?? true
  const locale = options?.locale ?? i18n.language ?? 'en'

  // Base options shared across both modes
  const base: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    day: 'numeric',
  }

  if (includeTime) {
    // Time mode: short month + time, using local timezone. hour12 交给 locale，
    // 中文是 15:30，en-US 是 3:30 PM。
    return new Date(date).toLocaleString(locale, {
      ...base,
      month: 'short',
      hour: 'numeric',
      minute: 'numeric',
    })
  }

  // Date-only mode: long month, using local timezone
  return new Date(date).toLocaleDateString(locale, {
    ...base,
    month: 'long',
  })
}
