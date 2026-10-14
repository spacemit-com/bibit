export const normalizeFeatureSearch = (search: Record<string, unknown>) => {
  const normalized: Record<string, string | readonly string[]> = {}
  Object.entries(search).forEach(([key, value]) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      normalized[key] = String(value)
      return
    }
    if (
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean'
      )
    ) {
      normalized[key] = value.map(String)
    }
  })
  return normalized
}
