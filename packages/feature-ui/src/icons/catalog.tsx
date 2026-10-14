import type { ReactNode } from 'react'
import type { FeatureIconKey } from '@bibit/feature-contracts'

export interface FeatureIconProps {
  className?: string
  width?: number | string
  height?: number | string
}

export type FeatureIcon = (props: FeatureIconProps) => ReactNode

const icon = (path: ReactNode): FeatureIcon => (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" {...props}>
    {path}
  </svg>
)

export const featureIconCatalog: Readonly<Record<FeatureIconKey, FeatureIcon>> = {
  store: icon(<><path d="M4 9h16l-1-5H5L4 9Z" /><path d="M6 9v11h12V9M9 20v-6h6v6" /></>),
  memory: icon(<><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3" /></>),
  security: icon(<path d="M12 2 4 5v6c0 5 3.4 9 8 11 4.6-2 8-6 8-11V5l-8-3Z" />),
  feature: icon(<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />),
  settings: icon(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2" /></>),
  activity: icon(<path d="M3 12h4l3-8 4 16 3-8h4" />),
  brain: icon(<><path d="M12 5.5A3 3 0 0 0 6.2 6 3 3 0 0 0 5 11.5 3 3 0 0 0 7 17a3 3 0 0 0 5 1.5V5.5Z" /><path d="M12 5.5A3 3 0 0 1 17.8 6 3 3 0 0 1 19 11.5 3 3 0 0 1 17 17a3 3 0 0 1-5 1.5" /></>),
  gauge: icon(<><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4.5-5" /></>),
  link: icon(<><path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-.8.8" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l.8-.8" /></>),
  logs: icon(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 16h6" /></>),
  plug: icon(<><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v5" /></>),
  puzzle: icon(<path d="M4 4h5a3 3 0 0 1 6 0h5v5a3 3 0 0 1 0 6v5H4V4Z" />),
  radio: icon(<><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></>),
  server: icon(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><circle cx="7" cy="7.5" r=".75" /><circle cx="7" cy="16.5" r=".75" /></>),
  sparkles: icon(<><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" /><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" /></>),
  users: icon(<><circle cx="9" cy="7.5" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="8" r="2.5" /><path d="M15 14.5h4a4.5 4.5 0 0 1 4.5 4.5" /></>),
  wrench: icon(<path d="M17.5 3.5a5 5 0 0 0-5.4 8L4 19.6 6.4 22l8.1-8.1a5 5 0 0 0 8-5.4l-3.5 3.5-2.6-2.6 3.5-3.5a5 5 0 0 0-2.4-1.2Z" />),
}

/**
 * Unknown keys fall back to the generic icon: a plugin that declares an icon
 * this build does not ship yet must render, not break the shell. The catalog
 * itself stays exhaustive over `FeatureIconKey`, so adding a key to the
 * contracts without adding the glyph is still a type error.
 */
export const getFeatureIcon = (key: string): FeatureIcon =>
  featureIconCatalog[key as FeatureIconKey] ?? featureIconCatalog.feature
