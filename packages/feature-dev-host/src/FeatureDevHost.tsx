import {
  default as React,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import type {
  ExternalServiceGatewayResponseV1,
  FileGrantPublishRequestV1,
  FileGrantRequestV1,
  FileGrantV1,
  FeatureHostCapability,
  FeatureManifestV1,
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'
import {
  EXTERNAL_SERVICE_PROTOCOL_VERSION,
  FILE_GRANT_CONTRACT_VERSION,
} from '@bibit/feature-contracts'
import {
  FeatureHostApiProvider,
  type FeatureExternalServiceIdV1,
  type FeatureExternalServiceRequestV1,
  type FeatureFileTransferApiV1,
  type FeatureHostApiV1,
  type FeatureModuleV1,
  type FeaturePageProps,
  type FeatureSettingsProps,
  type PermissionPresenterProps,
} from '@bibit/feature-sdk'

type ServiceMock = (input: {
  operationId: string
  params: Readonly<Record<string, unknown>>
}) => unknown | Promise<unknown>

export interface FeatureFileTransferMock {
  select?: (
    input: FileGrantRequestV1
  ) => FileGrantV1 | null | Promise<FileGrantV1 | null>
  publish?: (input: FileGrantPublishRequestV1) => void | Promise<void>
}

export interface FeatureDevHostProps {
  language?: string
  manifest: FeatureManifestV1
  module: FeatureModuleV1
  serviceMocks?: Partial<Record<FeatureExternalServiceIdV1, ServiceMock>>
  serviceConnections?: Partial<Record<FeatureExternalServiceIdV1, string>>
  fileTransferMock?: FeatureFileTransferMock
  permissionRequest?: PermissionRequestV1
  hostApi?: FeatureHostApiV1
}

type RoutedPreview = {
  key: string
  label: string
  kind: 'page' | 'settings'
  component: ComponentType<FeaturePageProps | FeatureSettingsProps>
  contributionId: string
}

type PermissionPreview = Omit<RoutedPreview, 'kind' | 'component'> & {
  kind: 'permission'
  component: ComponentType<PermissionPresenterProps>
}

type Preview = RoutedPreview | PermissionPreview

const defaultPermissionRequest = (featureId: string): PermissionRequestV1 => ({
  version: 1,
  runtimeInstanceId: 'dev-host-runtime-instance',
  runtimeId: 'dev-host-runtime',
  runtimeEpoch: 'dev-host-epoch',
  sessionId: 'dev-host-session',
  threadId: 'dev-host-thread',
  runId: 'dev-host-run',
  requestId: 'dev-host-request',
  toolCallId: 'dev-host-tool-call',
  action: {
    kind: 'tool',
    name: `${featureId}.demo`,
    summary: 'Preview a permission request in the Feature Dev Host',
  },
  supportedDecisions: ['allow_once', 'deny'],
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(300_000).toISOString(),
})

const capabilityService = (capability: FeatureHostCapability) =>
  capability.startsWith('service:')
    ? (capability.slice('service:'.length) as FeatureExternalServiceIdV1)
    : capability.startsWith('external-service:')
      ? (capability.slice('external-service:'.length) as FeatureExternalServiceIdV1)
      : undefined

const defaultFileGrant = (input: FileGrantRequestV1): FileGrantV1 => ({
  version: FILE_GRANT_CONTRACT_VERSION,
  grantId: `dev-host-${input.direction}`,
  direction: input.direction,
  displayName: input.suggestedName ?? `dev-host-${input.direction}`,
  expiresAt: new Date(0).toISOString(),
})

const createFileTransferCapability = (
  mock: FeatureFileTransferMock | undefined
): FeatureFileTransferApiV1 => ({
  select: async (input) =>
    mock?.select ? await mock.select(input) : defaultFileGrant(input),
  publish: async (input) => {
    await mock?.publish?.(input)
  },
})

const createHostApi = (
  manifest: FeatureManifestV1,
  mocks: FeatureDevHostProps['serviceMocks'],
  connections: FeatureDevHostProps['serviceConnections'],
  fileTransferMock: FeatureDevHostProps['fileTransferMock']
): FeatureHostApiV1 => {
  const capabilities: Record<string, unknown> = Object.fromEntries(
    manifest.requiredHostCapabilities.flatMap((capability) => {
      const serviceId = capabilityService(capability)
      const mock = serviceId ? mocks?.[serviceId] : undefined
      const endpoint = serviceId ? connections?.[serviceId] : undefined
      if (!serviceId || (!mock && !endpoint)) return []
      return [
        [
          capability,
          {
            request: async (
              input: FeatureExternalServiceRequestV1<typeof serviceId>
            ) => {
              if (mock) {
                return await mock({
                  operationId: input.operationId,
                  params: input.params,
                })
              }
              const requestId =
                globalThis.crypto?.randomUUID?.() ??
                `dev-service-${Date.now()}-${Math.random().toString(16).slice(2)}`
              const response = await fetch(endpoint!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: input.signal,
                body: JSON.stringify({
                  protocolVersion: EXTERNAL_SERVICE_PROTOCOL_VERSION,
                  requestId,
                  serviceId,
                  operationId: input.operationId,
                  params: input.params,
                  timeoutMs: input.timeoutMs ?? 30_000,
                }),
              })
              if (!response.ok) throw new Error('External service is unavailable')
              const envelope =
                (await response.json()) as ExternalServiceGatewayResponseV1
              if (
                envelope.protocolVersion !== EXTERNAL_SERVICE_PROTOCOL_VERSION ||
                envelope.requestId !== requestId
              ) {
                throw new Error('External service response is incompatible')
              }
              if (!envelope.ok) throw new Error(envelope.error.message)
              return envelope.result
            },
          },
        ],
      ]
    })
  )
  if (manifest.requiredHostCapabilities.includes('file:transfer')) {
    capabilities['file:transfer'] =
      createFileTransferCapability(fileTransferMock)
  }
  const grantedCapabilities = Object.keys(capabilities) as FeatureHostCapability[]
  return {
    sdkApiVersion: 1,
    featureId: manifest.id,
    grantedCapabilities,
    getCapability: (capability) => capabilities[capability],
  } as FeatureHostApiV1
}

const hasHorizontalOverflow = (element: HTMLElement) =>
  element.scrollWidth > element.clientWidth

const hasNestedSettingsShell = (element: HTMLElement) =>
  element.querySelector('main, [role="main"]') !== null

const SettingsPreview = ({ children }: { children: ReactNode }) => {
  const contentRef = useRef<HTMLDivElement>(null)
  const [contractError, setContractError] = useState<
    'nested-shell' | 'overflow' | null
  >(null)

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const check = () => {
      setContractError(
        hasNestedSettingsShell(content)
          ? 'nested-shell'
          : hasHorizontalOverflow(content)
            ? 'overflow'
            : null
      )
    }
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
    const observeContent = () => {
      check()
      resizeObserver?.disconnect()
      resizeObserver?.observe(content)
      content
        .querySelectorAll<HTMLElement>('*')
        .forEach((element) => resizeObserver?.observe(element))
    }
    observeContent()
    const mutationObserver = new MutationObserver(observeContent)
    mutationObserver.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'class', 'style'],
    })
    return () => {
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  return (
    <div className="bibit-dev-host__settings-shell" aria-label="Bibit settings shell preview">
      <header><h2>设置</h2></header>
      <div className="bibit-dev-host__settings-body">
        <aside aria-label="Bibit settings menu preview">
          <span>常规</span>
          <strong>当前插件</strong>
        </aside>
        <div
          ref={contentRef}
          className="bibit-dev-host__settings-content"
          data-bibit-settings-content-preview
        >
          {children}
        </div>
      </div>
      {contractError ? (
        <p className="bibit-dev-host__contract-error" role="alert">
          {contractError === 'nested-shell'
            ? '设置 renderer 包含重复的应用外壳，请只保留当前设置项的内容。'
            : '插件内容超出 Bibit 设置内容区，请移除重复侧栏或固定宽度。'}
        </p>
      ) : null}
    </div>
  )
}

const PreviewFrame = ({
  children,
  kind,
}: {
  children: ReactNode
  kind: Preview['kind']
}) => (
  <section className="bibit-dev-host__preview" aria-label="Feature preview">
    <div className="bibit-dev-host__viewport-label">
      desktop / main / {kind}
    </div>
    {kind === 'settings' ? (
      <SettingsPreview>{children}</SettingsPreview>
    ) : (
      <div className="bibit-dev-host__canvas">{children}</div>
    )}
  </section>
)

export function FeatureDevHost({
  language = 'en',
  manifest,
  module,
  serviceMocks,
  serviceConnections,
  fileTransferMock,
  permissionRequest = defaultPermissionRequest(manifest.id),
  hostApi: injectedHostApi,
}: FeatureDevHostProps) {
  const previews = useMemo<Preview[]>(() => {
    const pagePreviews = manifest.contributions.pages.flatMap(({ id }) => {
      const component = module.pages?.[id]
      return component
        ? [{ key: `page:${id}`, label: `Page · ${id}`, kind: 'page' as const, component, contributionId: id }]
        : []
    })
    const settingsPreviews = manifest.contributions.settings.flatMap(({ id }) => {
      const component = module.settings?.[id]
      return component
        ? [{ key: `settings:${id}`, label: `Settings · ${id}`, kind: 'settings' as const, component, contributionId: id }]
        : []
    })
    const permissionPreviews = manifest.contributions.conversation
      .filter(({ kind }) => kind === 'permission-presenter')
      .flatMap(({ id }) => {
        const component = module.permissionPresenters?.[id]
        return component
          ? [{ key: `permission:${id}`, label: `Permission · ${id}`, kind: 'permission' as const, component, contributionId: id }]
          : []
      })
    return [...pagePreviews, ...settingsPreviews, ...permissionPreviews]
  }, [manifest, module])
  const [selectedKey, setSelectedKey] = useState(previews[0]?.key ?? '')
  const [permissionState, setPermissionState] = useState<PermissionPresenterProps['viewState']>({ status: 'pending' })
  const selected = previews.find(({ key }) => key === selectedKey) ?? previews[0]
  const hostApi = useMemo(
    () =>
      injectedHostApi ??
      createHostApi(manifest, serviceMocks, serviceConnections, fileTransferMock),
    [injectedHostApi, manifest, serviceMocks, serviceConnections, fileTransferMock]
  )

  if (!selected) {
    return <div role="alert">Manifest does not expose a renderable contribution.</div>
  }

  const navigation = { push() {}, replace() {}, back() {} }
  const baseProps: FeaturePageProps | FeatureSettingsProps = {
    language,
    featureId: manifest.id,
    contributionId: selected.contributionId,
    subpath: '',
    search: {},
    navigation,
  }
  const decide = async (
    decision: PermissionDecisionV1
  ): Promise<PermissionDecisionReceiptV1> => {
    setPermissionState({ status: 'submitting' })
    const receipt: PermissionDecisionReceiptV1 = {
      ...decision,
      status: 'accepted',
    }
    setPermissionState({ status: 'resolved' })
    return receipt
  }
  let component: ReactNode
  if (selected.kind === 'permission') {
    const PermissionComponent = selected.component
    component = (
      <PermissionComponent
        request={permissionRequest}
        surface="main"
        viewState={permissionState}
        decide={decide}
      />
    )
  } else {
    const RoutedComponent = selected.component
    component = (
      <FeatureHostApiProvider value={hostApi}>
        <RoutedComponent {...baseProps} />
      </FeatureHostApiProvider>
    )
  }

  return (
    <main className="bibit-dev-host">
      <aside className="bibit-dev-host__rail">
        <p className="bibit-dev-host__eyebrow">Bibit Feature Workbench</p>
        <h1>{manifest.display.fallbackTitle}</h1>
        <dl className="bibit-dev-host__contract">
          <div><dt>Feature</dt><dd>{manifest.id}</dd></div>
          <div><dt>Version</dt><dd>{manifest.version}</dd></div>
          <div><dt>Contract</dt><dd>SDK {manifest.sdkApiVersion}</dd></div>
        </dl>
        <nav aria-label="Feature contributions">
          {previews.map((preview) => (
            <button
              key={preview.key}
              type="button"
              className={preview.key === selected.key ? 'is-active' : undefined}
              onClick={() => setSelectedKey(preview.key)}
            >
              {preview.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="bibit-dev-host__stage">
        <header>
          <div>
            <span className="bibit-dev-host__status-dot" /> Contract loaded
          </div>
          <code>{selected.key}</code>
        </header>
        <PreviewFrame kind={selected.kind}>{component}</PreviewFrame>
      </div>
    </main>
  )
}
