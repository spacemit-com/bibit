import { useEffect } from 'react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'
import { ACCENT_COLORS } from '@/hooks/useInterfaceSettings'

/**
 * InterfaceProvider ensures interface settings are applied on every page load
 * This component should be mounted at the root level of the application
 */
export function InterfaceProvider() {
  const { fontSize, accentColor } = useInterfaceSettings()
  const { isDark } = useTheme()

  // Apply interface settings on mount and when they change
  useEffect(() => {
    // Apply font size
    document.documentElement.style.setProperty('--font-size-base', fontSize)
  }, [fontSize])

  // Apply the accent color to primary UI elements while keeping the sidebar on
  // the default Gray palette regardless of the selected accent.
  useEffect(() => {
    const color = ACCENT_COLORS.find((c) => c.value === accentColor)
    const defaultColor = ACCENT_COLORS.find((c) => c.value === 'gray')
    if (!color || !defaultColor) return

    const root = document.documentElement
    const defaultSidebarColor = isDark
      ? defaultColor.sidebar.dark
      : defaultColor.sidebar.light
    // The default Gray palette uses a bright lime primary, so primary button
    // labels need a pure black foreground for sufficient contrast. Other
    // accent palettes retain the original light/dark foreground values.
    const primaryForeground =
      accentColor === 'gray'
        ? '#000000'
        : isDark
          ? 'oklch(0.205 0 0)'
          : 'oklch(0.985 0 0)'

    root.style.setProperty('--sidebar', defaultSidebarColor)
    root.style.setProperty('--primary', color.primary)
    root.style.setProperty('--primary-foreground', primaryForeground)
  }, [accentColor, isDark])

  return null
}
