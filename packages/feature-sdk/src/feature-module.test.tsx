import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  FeatureHostApiProvider,
  useFeatureHostApi,
  type FeatureHostApiV1,
  type FeatureModuleV1,
  type PermissionPresenterProps,
} from './index'
import type {
  PermissionDecisionReceiptV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'
import type { FeatureExternalServiceApiV1 } from './host-api'

const hostApi: FeatureHostApiV1 = {
  sdkApiVersion: 1,
  featureId: 'fixture',
  grantedCapabilities: [],
  getCapability: () => undefined,
}

function Page() {
  return createElement('span', null, useFeatureHostApi().featureId)
}

const moduleFixture = {
  sdkApiVersion: 1,
  pages: { home: Page },
} satisfies FeatureModuleV1

describe('Feature SDK public contract', () => {
  it('exposes permission presenters with only the request DTO and idempotent decision callback', () => {
    const Presenter = ({ request, surface, viewState, decide }: PermissionPresenterProps) => {
      void decide({
        version: 1,
        runtimeInstanceId: request.runtimeInstanceId,
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        runtimeEpoch: request.runtimeEpoch,
        sessionId: request.sessionId,
        threadId: request.threadId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        decision: 'deny',
        reason: 'user-denied',
      })
      expect(surface).toBe('main')
      expect(viewState.status).toBe('pending')
      return null
    }
    const request: PermissionRequestV1 = {
      version: 1,
      runtimeInstanceId: 'current-tool-instance-1',
      requestId: 'request-1',
      runtimeId: 'current-tool-approval',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      runId: 'run-1',
      toolCallId: 'request-1',
      action: { kind: 'tool', name: 'read', summary: 'Run read' },
      supportedDecisions: ['allow_once', 'deny'],
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(60_000).toISOString(),
    }
    const receipt: PermissionDecisionReceiptV1 = {
      version: 1,
      runtimeInstanceId: request.runtimeInstanceId,
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      runtimeEpoch: request.runtimeEpoch,
      sessionId: request.sessionId,
      threadId: request.threadId,
      runId: request.runId,
      toolCallId: request.toolCallId,
      decision: 'deny',
      status: 'accepted',
    }
    const permissionModule = {
      sdkApiVersion: 1,
      permissionPresenters: { approval: Presenter },
    } satisfies FeatureModuleV1

    expect(permissionModule.permissionPresenters.approval).toBe(Presenter)
    expect(request.requestId).toBe('request-1')
    expect(receipt.status).toBe('accepted')
  })
  it('exposes narrow external-service capability types without host augmentation', () => {
    type StoreApi = FeatureExternalServiceApiV1<'store'>
    const input: Parameters<StoreApi['request']>[0] = {
      serviceId: 'store',
      operationId: 'list',
      params: {},
    }
    expect(input.serviceId).toBe('store')
  })
  it('provides Host API to a typed Feature Module component', () => {
    const Component = moduleFixture.pages.home
    const html = renderToStaticMarkup(
      createElement(
        FeatureHostApiProvider,
        { value: hostApi },
        createElement(Component, {
          featureId: 'fixture',
          contributionId: 'home',
          subpath: '',
          search: {},
          navigation: {
            push: () => {},
            replace: () => {},
            back: () => {},
          },
        })
      )
    )
    expect(html).toBe('<span>fixture</span>')
  })

  it('fails clearly when a Feature is mounted outside its host', () => {
    expect(() => renderToStaticMarkup(createElement(Page))).toThrow(
      'FeatureHostApiProvider'
    )
  })
})
