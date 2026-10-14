import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import {
  useFeatureCapability,
  type FeatureHostApiV1,
  type FeatureModuleV1,
} from '@bibit/feature-sdk'
import { FeatureDevHost } from './FeatureDevHost'

const manifest: FeatureManifestV1 = {
  manifestSchemaVersion: 1,
  sdkApiVersion: 1,
  id: 'fixture',
  version: '0.1.0',
  owner: 'fixture-team',
  display: {
    titleKey: 'fixture:title',
    fallbackTitle: 'Fixture',
    iconKey: 'feature',
  },
  targets: ['desktop'],
  requiredHostCapabilities: [],
  contributions: {
    pages: [{ id: 'home', path: '', surfaces: ['main'] }],
    settings: [{ id: 'preferences', path: '', surfaces: ['main'] }],
    conversation: [],
    locales: ['en'],
  },
}

const module: FeatureModuleV1 = {
  sdkApiVersion: 1,
  pages: { home: () => <h2>Feature page</h2> },
  settings: { preferences: () => <h2>Feature settings</h2> },
}

describe('FeatureDevHost', () => {
  it('defaults contribution language to English and forwards language changes', () => {
    const localizedModule: FeatureModuleV1 = { sdkApiVersion: 1, pages: { home: ({ language }) => <p data-testid="language">{language}</p> } }
    const view = render(<FeatureDevHost manifest={manifest} module={localizedModule} />)
    expect(screen.getByTestId('language').textContent).toBe('en')
    view.rerender(<FeatureDevHost manifest={manifest} module={localizedModule} language="zh" />)
    expect(screen.getByTestId('language').textContent).toBe('zh')
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('switches between declared contributions without Bibit', async () => {
    const user = userEvent.setup()
    render(<FeatureDevHost manifest={manifest} module={module} />)

    expect(screen.getByRole('heading', { name: 'Feature page' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Settings · preferences' }))
    expect(screen.getByRole('heading', { name: 'Feature settings' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
    expect(screen.getByLabelText('Bibit settings menu preview')).toBeTruthy()
    expect(document.querySelector('[data-bibit-settings-content-preview]')).toBeTruthy()
    expect(screen.getByText('SDK 1')).toBeTruthy()
  })

  it('uses an injected scripted Host API without implementing a second scheduler', () => {
    function TransferPage() {
      return (
        <h2>{useFeatureCapability('file:transfer') ? 'Transfer ready' : 'Unavailable'}</h2>
      )
    }
    const transferManifest: FeatureManifestV1 = {
      ...manifest,
      requiredHostCapabilities: ['file:transfer'],
      contributions: { ...manifest.contributions, settings: [] },
    }
    const transferModule: FeatureModuleV1 = {
      sdkApiVersion: 1,
      pages: { home: TransferPage },
    }
    const hostApi = {
      sdkApiVersion: 1,
      featureId: 'fixture',
      grantedCapabilities: ['file:transfer'],
      getCapability: () => ({ select: vi.fn() }),
    } as FeatureHostApiV1

    render(
      <FeatureDevHost
        manifest={transferManifest}
        module={transferModule}
        hostApi={hostApi}
      />
    )
    expect(screen.getByRole('heading', { name: 'Transfer ready' })).toBeTruthy()
  })

  const transferManifest: FeatureManifestV1 = {
    ...manifest,
    requiredHostCapabilities: ['file:transfer'],
    contributions: { ...manifest.contributions, settings: [] },
  }

  function TransferProbe() {
    const transfer = useFeatureCapability('file:transfer')
    const [state, setState] = useState('idle')
    if (!transfer) return <h2>Unavailable</h2>
    const run = async () => {
      const grant = await transfer.select({
        version: 1,
        serviceId: 'memory',
        operationId: 'privacy.export_data',
        direction: 'download',
        suggestedName: 'export.json',
      })
      if (!grant) {
        setState('cancelled')
        return
      }
      await transfer.publish({
        version: 1,
        grantId: grant.grantId,
        serviceId: 'memory',
        operationId: 'privacy.export_data',
        content: new TextEncoder().encode('{"memory":"ok"}'),
      })
      setState(JSON.stringify(grant))
    }
    return (
      <div>
        <h2>Transfer ready</h2>
        <p data-testid="transfer-state">{state}</p>
        <button onClick={() => void run()}>Export</button>
      </div>
    )
  }

  it('forwards file transfer selections and publishes to the injected mock', async () => {
    const user = userEvent.setup()
    const fileTransferMock = {
      select: vi.fn().mockResolvedValue({
        version: 1,
        grantId: 'dev-grant',
        direction: 'download',
        displayName: 'export.json',
        expiresAt: new Date(0).toISOString(),
      }),
      publish: vi.fn().mockResolvedValue(undefined),
    }
    render(
      <FeatureDevHost
        manifest={transferManifest}
        module={{ sdkApiVersion: 1, pages: { home: TransferProbe } }}
        fileTransferMock={fileTransferMock}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Export' }))

    expect(fileTransferMock.select).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'download',
        serviceId: 'memory',
        operationId: 'privacy.export_data',
      })
    )
    expect(fileTransferMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'dev-grant' })
    )
    expect(screen.getByTestId('transfer-state').textContent).toContain(
      'dev-grant'
    )
  })

  it('serves a path-free default grant when no file transfer mock is injected', async () => {
    const user = userEvent.setup()
    render(
      <FeatureDevHost
        manifest={transferManifest}
        module={{ sdkApiVersion: 1, pages: { home: TransferProbe } }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Export' }))

    const state = screen.getByTestId('transfer-state').textContent ?? ''
    expect(state).toContain('grantId')
    expect(state).not.toContain('/')
  })

  it('withholds file transfer when the manifest does not declare it', () => {
    render(
      <FeatureDevHost
        manifest={manifest}
        module={{ sdkApiVersion: 1, pages: { home: TransferProbe } }}
      />
    )

    expect(screen.getByRole('heading', { name: 'Unavailable' })).toBeTruthy()
  })

  it('reports settings content that duplicates the application shell', async () => {
    const user = userEvent.setup()
    const invalidModule: FeatureModuleV1 = {
      ...module,
      settings: { preferences: () => <main>Duplicate shell</main> },
    }
    render(<FeatureDevHost manifest={manifest} module={invalidModule} />)

    await user.click(screen.getByRole('button', { name: 'Settings · preferences' }))
    expect(screen.getByRole('alert').textContent).toContain('重复的应用外壳')
  })

  it('revalidates settings content when an existing role attribute changes', async () => {
    const user = userEvent.setup()
    const dynamicModule: FeatureModuleV1 = {
      ...module,
      settings: {
        preferences: () => <section data-testid="dynamic-shell">Content</section>,
      },
    }
    render(<FeatureDevHost manifest={manifest} module={dynamicModule} />)

    await user.click(screen.getByRole('button', { name: 'Settings · preferences' }))
    screen.getByTestId('dynamic-shell').setAttribute('role', 'main')

    expect((await screen.findByRole('alert')).textContent).toContain(
      '重复的应用外壳'
    )
  })

  it('reports settings content wider than the available area', async () => {
    const user = userEvent.setup()
    const overflowingModule: FeatureModuleV1 = {
      ...module,
      settings: {
        preferences: () => (
          <div
            ref={(node) => {
              const content = node?.parentElement
              if (!content) return
              Object.defineProperties(content, {
                scrollWidth: { configurable: true, value: 701 },
                clientWidth: { configurable: true, value: 700 },
              })
            }}
          >
            Wide content
          </div>
        ),
      },
    }
    render(<FeatureDevHost manifest={manifest} module={overflowingModule} />)

    await user.click(screen.getByRole('button', { name: 'Settings · preferences' }))
    expect(screen.getByRole('alert').textContent).toContain('超出 Bibit 设置内容区')
  })

  it('revalidates overflow when a non-first descendant resizes', async () => {
    let resizeCallback: ResizeObserverCallback = () => undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe = observe
      unobserve = vi.fn()
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    const user = userEvent.setup()
    const dynamicModule: FeatureModuleV1 = {
      ...module,
      settings: {
        preferences: () => (
          <div>
            <span>First</span>
            <span data-testid="resized-descendant">Second</span>
          </div>
        ),
      },
    }
    const { unmount } = render(
      <FeatureDevHost manifest={manifest} module={dynamicModule} />
    )

    await user.click(screen.getByRole('button', { name: 'Settings · preferences' }))
    const content = document.querySelector(
      '[data-bibit-settings-content-preview]'
    ) as HTMLElement
    const descendant = screen.getByTestId('resized-descendant')
    expect(observe).toHaveBeenCalledWith(descendant)
    Object.defineProperties(content, {
      scrollWidth: { configurable: true, value: 701 },
      clientWidth: { configurable: true, value: 700 },
    })
    resizeCallback([], {} as ResizeObserver)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        '超出 Bibit 设置内容区'
      )
    )
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('disconnects settings observers on unmount', async () => {
    const resizeDisconnect = vi.fn()
    const mutationDisconnect = vi.fn()
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect = resizeDisconnect
    }
    class MutationObserverMock {
      observe() {}
      takeRecords() {
        return []
      }
      disconnect = mutationDisconnect
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('MutationObserver', MutationObserverMock)

    const user = userEvent.setup()
    const rendered = render(<FeatureDevHost manifest={manifest} module={module} />)
    await user.click(screen.getByRole('button', { name: 'Settings · preferences' }))
    const resizeDisconnectsBeforeUnmount = resizeDisconnect.mock.calls.length
    rendered.unmount()

    expect(resizeDisconnect).toHaveBeenCalledTimes(
      resizeDisconnectsBeforeUnmount + 1
    )
    expect(mutationDisconnect).toHaveBeenCalled()
  })

  it('connects a declared capability to a v1 external service endpoint', async () => {
    const connectedManifest: FeatureManifestV1 = {
      ...manifest,
      requiredHostCapabilities: ['external-service:store'],
      contributions: {
        ...manifest.contributions,
        settings: [],
      },
    }
    function ConnectedPage() {
      const store = useFeatureCapability('external-service:store')
      const [name, setName] = useState('Loading')
      useEffect(() => {
        void store
          ?.request<{ name: string }>({
            serviceId: 'store',
            operationId: 'agents.get.v1',
            params: { id: 'agent-1' },
          })
          .then((result) => setName(result.name))
      }, [store])
      return <h2>{name}</h2>
    }
    const connectedModule: FeatureModuleV1 = {
      sdkApiVersion: 1,
      pages: { home: ConnectedPage },
    }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return {
        ok: true,
        json: async () => ({
          protocolVersion: 1,
          requestId: request.requestId,
          ok: true,
          result: { name: 'Connected agent' },
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <FeatureDevHost
        manifest={connectedManifest}
        module={connectedModule}
        serviceConnections={{ store: '/dev-services/store/invoke' }}
      />
    )

    expect(await screen.findByRole('heading', { name: 'Connected agent' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/dev-services/store/invoke',
      expect.objectContaining({ method: 'POST' })
    )
  })
})
