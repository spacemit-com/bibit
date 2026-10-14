import { invoke } from '@tauri-apps/api/core'
import type { FeatureFileTransferApiV1 } from '@bibit/feature-sdk'
import type { FileGrantPublishRequestV1, FileGrantV1 } from '@bibit/feature-contracts'

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

const BASE64_CHUNK_BYTES = 0x8000

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)
    )
  }
  return btoa(binary)
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // WebCrypto 要求 BufferSource 由普通 ArrayBuffer 支撑，视图本身不保证这一点。
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export const createFileTransferApi = (
  featureId: string,
  pluginVersion: string,
  featureInstanceToken: string,
  tauriInvoke: TauriInvoke = invoke
): FeatureFileTransferApiV1 => ({
  select: ({ version, ...input }) => {
    if (version !== 1) {
      return Promise.reject(
        new Error('Unsupported file transfer request version')
      )
    }
    return tauriInvoke<FileGrantV1 | null>('feature_file_grant_select', {
      request: { featureId, pluginVersion, featureInstanceToken, ...input },
    })
  },
  publish: async (request: FileGrantPublishRequestV1) => {
    const { version, grantId, serviceId, operationId, content } = request
    if (version !== 1) {
      throw new Error('Unsupported file transfer request version')
    }
    if (!grantId) {
      throw new Error('A file grant id is required')
    }
    await tauriInvoke<void>('feature_file_grant_publish', {
      request: {
        featureId,
        pluginVersion,
        featureInstanceToken,
        grantId,
        serviceId,
        operationId,
        contentBase64: encodeBase64(content),
        byteLength: content.byteLength,
        sha256: await sha256Hex(content),
      },
    })
  },
})
