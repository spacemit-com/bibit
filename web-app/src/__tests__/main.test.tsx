import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  surface: 'main' as 'main' | 'voice-ball' | 'voice-overlay',
  voiceBall: vi.fn(() => null),
  ensureLocalesLoaded: vi.fn(async () => {
    h.order.push('locales')
  }),
  order: [] as string[],
  preloadLocales: vi.fn(async (_entries: unknown) => {}),
  activeEntries: [],
  readyHandlers: [] as Array<() => void>,
}))

// Mock ReactDOM
const mockRender = vi.fn(() => {
  h.order.push('render')
})
const mockCreateRoot = vi.fn().mockReturnValue({ render: mockRender })

vi.mock('react-dom/client', () => ({
  default: {
    createRoot: mockCreateRoot,
  },
  createRoot: mockCreateRoot,
}))

// Mock router
vi.mock('@tanstack/react-router', () => ({
  RouterProvider: ({ router }: { router: any }) => `<RouterProvider router={router} />`,
  createRouter: vi.fn().mockReturnValue('mocked-router'),
  createRootRoute: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main' }),
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  once: async (_event: string, handler: () => void) => {
    h.readyHandlers.push(handler)
    return () => {}
  },
}))

vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => h.surface,
}))
vi.mock('@/components/VoiceBall', () => ({ VoiceBall: h.voiceBall }))
vi.mock('../features/host/trustedPluginLoader', () => ({
  loadTrustedPluginEntries: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/features/activeFeatureRegistry', () => ({
  bootstrapStaticFeatureRegistry: vi.fn().mockResolvedValue(undefined),
  setRuntimeFeatureRegistry: vi.fn(),
}))
vi.mock('@/features/host-api', () => ({
  loadRuntimeFeatureCapabilityGrants: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/services/app/console-logger', () => ({ installConsoleLogForwarding: vi.fn() }))
vi.mock('@/features/activeFeatureRegistry', () => ({
  bootstrapStaticFeatureRegistry: async () => {},
  setRuntimeFeatureRegistry: vi.fn(),
  activeFeatureRegistry: h.activeEntries,
}))
vi.mock('@/features/host/preloadFeatureNavigationLocales', () => ({ preloadFeatureNavigationLocales: h.preloadLocales }))

// Dynamically-imported modules (kept out of the static boot graph)
vi.mock('../routeTree.gen', () => ({
  routeTree: 'mocked-route-tree',
}))
vi.mock('../index.css', () => ({}))
vi.mock('../i18n', () => ({ ensureLocalesLoaded: h.ensureLocalesLoaded }))

describe('main.tsx', () => {
  let mockGetElementById: any
  let mockRootElement: any

  beforeEach(() => {
    mockRootElement = {
      innerHTML: '',
    }
    mockGetElementById = vi.fn().mockReturnValue(mockRootElement)
    Object.defineProperty(document, 'getElementById', {
      value: mockGetElementById,
      writable: true,
    })

    vi.clearAllMocks()
    h.preloadLocales.mockResolvedValue(undefined)
    h.readyHandlers = []
    h.order = []
    h.surface = 'main'
    document.body.classList.remove('loaded')
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('renders the app shell on boot', async () => {
    await import('../main')

    await vi.waitFor(() => expect(mockRender).toHaveBeenCalled())
    expect(mockCreateRoot).toHaveBeenCalledWith(mockRootElement)
  })

  it('preloads navigation locales only after the window is ready', async () => {
    await import('../main')
    await vi.waitFor(() => expect(mockRender).toHaveBeenCalledOnce())

    // The plugin bundles must not compete with the first render for the main
    // thread, so nothing is imported until ExtensionProvider emits app-ready.
    expect(h.readyHandlers).toHaveLength(1)
    expect(h.preloadLocales).not.toHaveBeenCalled()

    h.readyHandlers[0]()

    await vi.waitFor(() => expect(h.preloadLocales).toHaveBeenCalledWith(h.activeEntries))
  })

  it('renders voice-ball before global boot tasks', async () => {
    h.surface = 'voice-ball'

    await import('../main')

    await vi.waitFor(() => expect(mockRender).toHaveBeenCalled())
    expect(mockRender.mock.calls[0][0].props.children.type).toBe(h.voiceBall)
    expect(h.preloadLocales).not.toHaveBeenCalled()
    expect(document.body).toHaveClass('loaded')
    // 悬浮球窗口有自己的 JS 上下文，语言包不加载就会把 t() 的 key 当文案显示
    // （tooltip 直接变成 `chat:openVoiceInput`）。
    expect(h.order).toEqual(['locales', 'render'])
  })

  it('should not render app when root element already has content', async () => {
    mockRootElement.innerHTML = '<div>existing content</div>'

    await import('../main')

    await vi.waitFor(() => expect(mockGetElementById).toHaveBeenCalledWith('root'))
    expect(mockCreateRoot).not.toHaveBeenCalled()
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('does not render when root element is missing', async () => {
    mockGetElementById.mockReturnValue(null)

    await import('../main')

    await vi.waitFor(() => expect(mockGetElementById).toHaveBeenCalledWith('root'))
    expect(mockRender).not.toHaveBeenCalled()
  })
})
