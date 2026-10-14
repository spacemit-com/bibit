export const FILE_GRANT_CONTRACT_VERSION = 1 as const

export const FILE_GRANT_DIRECTIONS_V1 = ['upload', 'download'] as const
export type FileGrantDirectionV1 = (typeof FILE_GRANT_DIRECTIONS_V1)[number]

export const FILE_GRANT_LIMITS_V1 = {
  maxActivePerFeatureService: 4,
  maxFileBytes: 256 * 1024 * 1024,
  maxStagingBytesPerFeatureService: 512 * 1024 * 1024,
} as const

export interface FileGrantRequestV1 {
  version: typeof FILE_GRANT_CONTRACT_VERSION
  serviceId: string
  operationId: string
  direction: FileGrantDirectionV1
  suggestedName?: string
  maxBytes?: number
}

/** Safe metadata returned to a Feature. Host filesystem paths are never public. */
export interface FileGrantV1 {
  version: typeof FILE_GRANT_CONTRACT_VERSION
  grantId: string
  direction: FileGrantDirectionV1
  displayName: string
  expiresAt: string
  byteLength?: number
}

/**
 * Bytes a Feature asks the Host to write at the download location the user
 * selected for `grantId`. The Host stages the bytes, verifies the byte length
 * and SHA-256 it derives itself, and replaces the selected file atomically.
 * Features still never see a filesystem path.
 */
export interface FileGrantPublishRequestV1 {
  version: typeof FILE_GRANT_CONTRACT_VERSION
  grantId: string
  serviceId: string
  operationId: string
  content: Uint8Array
}

/** Host-to-Provider locator, relative to the Provider data directory. */
export interface ProviderFileResourceV1 {
  resourcePath: string
  byteLength: number
  sha256?: string
}

const PROVIDER_RESOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const isSafeProviderResourcePathV1 = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 512 &&
  !path.includes('\\') &&
  path.split('/').every((segment) => PROVIDER_RESOURCE_SEGMENT.test(segment))
