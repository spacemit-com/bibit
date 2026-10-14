import type {
  FeatureManifestV1,
  FeatureServiceErrorV1,
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
  PermissionRequestV1,
} from './index'

export const manifestFixture = {
  manifestSchemaVersion: 1,
  sdkApiVersion: 1,
  id: 'memory',
  version: '0.1.0',
  owner: 'memory-team',
  display: {
    titleKey: 'memory:title',
    fallbackTitle: 'Memory',
    iconKey: 'memory',
  },
  targets: ['desktop'],
  requiredHostCapabilities: ['external-service:memory'],
  contributions: {
    pages: [],
    settings: [
      {
        id: 'manage',
        path: '',
        surfaces: ['main'],
        navigation: { group: 'features' },
      },
    ],
    conversation: [],
    locales: ['en'],
  },
} as const satisfies FeatureManifestV1

export const permissionRequestFixture = {
  version: 1,
  runtimeInstanceId: 'runtime-instance-1',
  requestId: 'permission-1',
  runtimeId: 'runtime-1',
  runtimeEpoch: 'epoch-1',
  sessionId: 'session-1',
  threadId: 'thread-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  action: { kind: 'tool', name: 'read-file', summary: 'Read a local file' },
  supportedDecisions: ['allow_once', 'deny'],
  createdAt: '2026-08-19T00:00:00.000Z',
  expiresAt: '2026-08-19T00:01:00.000Z',
} as const satisfies PermissionRequestV1

export const permissionDecisionFixture = {
  version: 1,
  runtimeInstanceId: 'runtime-instance-1',
  requestId: 'permission-1',
  runtimeId: 'runtime-1',
  runtimeEpoch: 'epoch-1',
  sessionId: 'session-1',
  threadId: 'thread-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  decision: 'deny',
  reason: 'user-denied',
} as const satisfies PermissionDecisionV1

export const permissionDecisionReceiptFixture = {
  ...permissionDecisionFixture,
  status: 'accepted',
} as const satisfies PermissionDecisionReceiptV1

export const serviceErrorFixture = {
  version: 1,
  code: 'offline',
  message: 'Service is offline',
  retryable: true,
} as const satisfies FeatureServiceErrorV1
