export {}

declare module 'react-syntax-highlighter-virtualized-renderer'

type AppCore = {
  api: APIs
  extensionManager: ExtensionManager | undefined
}

declare global {
  declare const IS_TAURI: boolean
  declare const IS_WEB_APP: boolean
  declare const IS_LINUX: boolean
  declare const VERSION: string
  declare const GA_MEASUREMENT_ID: string
  declare const IS_DEV: boolean
  declare const BIBIT_SECURITY_DEMO: boolean
  interface Window {
    core: AppCore | undefined
    gtag?: (...args: unknown[]) => void
    dataLayer?: unknown[]
  }
}
