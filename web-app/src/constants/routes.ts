export const route = {
  // home as new chat or thread
  home: '/',
  statusPopup: '/status-popup' as const,
  appLogs: '/logs',
  settings: {
    index: '/settings',
    general: '/settings/general',
    interface: '/settings/interface',
    shortcuts: '/settings/shortcuts',
    extensions: '/settings/extensions',
  },
  systemMonitor: '/system-monitor',
  threadsDetail: '/threads/$threadId',
}
