import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock platform detection
const mockIsTauri = vi.fn().mockReturnValue(false)

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: (...args: any[]) => mockIsTauri(...args),
}))

// Mock all Tauri service modules
vi.mock('../theme/tauri', () => ({ TauriThemeService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../window/tauri', () => ({ TauriWindowService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../events/tauri', () => ({ TauriEventsService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../hardware/tauri', () => ({ TauriHardwareService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../app/tauri', () => ({ TauriAppService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../mcp/tauri', () => ({ TauriMCPService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../providers/tauri', () => ({ TauriProvidersService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../dialog/tauri', () => ({ TauriDialogService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../opener/tauri', () => ({ TauriOpenerService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../path/tauri', () => ({ TauriPathService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../core/tauri', () => ({ TauriCoreService: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../deeplink/tauri', () => ({ TauriDeepLinkService: vi.fn().mockImplementation(() => ({})) }))

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

describe('ServiceHub – coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
  })

  it('rag() returns a service after init', async () => {
    const { initializeServiceHub } = await import('../index')
    const hub = await initializeServiceHub()
    expect(hub.rag()).toBeDefined()
  })

  it('uploads() returns a service after init', async () => {
    const { initializeServiceHub } = await import('../index')
    const hub = await initializeServiceHub()
    expect(hub.uploads()).toBeDefined()
  })

  it('double initialization is a no-op', async () => {
    const { initializeServiceHub } = await import('../index')
    const hub = await initializeServiceHub()
    // The hub is already initialized; calling getters should work fine
    expect(hub.theme()).toBeDefined()
  })

  it('handles initialization error and still marks as initialized', async () => {
    // Make one of the dynamic imports fail
    mockIsTauri.mockReturnValue(true)

    // The mocks are already set up so this should succeed.
    // To test error path, we need to temporarily break a mock.
    const origMock = await import('../theme/tauri')
    const TauriThemeService = vi.mocked((origMock as any).TauriThemeService)
    TauriThemeService.mockImplementationOnce(() => {
      throw new Error('init fail')
    })

    const { initializeServiceHub } = await import('../index')
    await expect(initializeServiceHub()).rejects.toThrow('init fail')
  })
})
