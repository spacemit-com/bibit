import type { BaseExtension } from '@janhq/core'
import type { ExtensionManifest } from '@/lib/extension'

type ExtensionCtor = new (
  url: string,
  name: string,
  productName?: string,
  active?: boolean,
  description?: string,
  version?: string
) => BaseExtension

type BundledEntry = {
  load: () => Promise<{ default: ExtensionCtor }>
  name: string
  productName: string
  version: string
  description: string
  // Runs on mobile (no native plugin dependencies). Desktop-only otherwise.
  mobile?: boolean
}

// Lazily imported so the extension bundles are NOT part of the service-hub
// bootstrap graph; they load only when extensions are enumerated (after the
// hub is ready), matching the pre-bundling load order.
const ENTRIES: BundledEntry[] = [
  {
    load: () => import('@janhq/conversational-extension'),
    name: '@janhq/conversational-extension',
    productName: 'Conversational',
    version: '1.0.0',
    description: 'Enables conversations and state persistence via your file system.',
    mobile: true,
  },
  {
    load: () => import('@janhq/download-extension'),
    name: '@janhq/download-extension',
    productName: 'Download Manager',
    version: '1.0.0',
    description: 'Download and manage files and AI models in BiBit.',
  },
  {
    load: () => import('@janhq/llamacpp-extension'),
    name: '@janhq/llamacpp-extension',
    productName: 'llama.cpp Inference Engine',
    version: '1.0.1',
    description: 'This extension enables llama.cpp chat completion API calls',
  },
  {
    load: () => import('@janhq/rag-extension'),
    name: '@janhq/rag-extension',
    productName: 'RAG Tools',
    version: '0.1.0',
    description:
      'Registers RAG tools and orchestrates retrieval across parser, embeddings, and vector DB',
  },
  {
    load: () => import('@janhq/vector-db-extension'),
    name: '@janhq/vector-db-extension',
    productName: 'Vector DB',
    version: '0.1.0',
    description: 'Vector DB integration using sqlite-vec if available with linear fallback',
  },
]

/**
 * 6 个扩展的类模块合计约 163KB，但在首帧门控里等它们取数实测 168ms
 * （`ext_register`），其中解析只占约 35ms，其余是 asset 协议的取数延迟。
 * 启动早期先把 fetch 打出去，注册路径后面的 `import()` 命中同一模块记录，
 * 就不再原地等网络了。同一个 specifier 的 import 由模块系统去重，可重复调用。
 */
export function prefetchBundledExtensionClasses(): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(ENTRIES.map(({ load }) => load()))
}

export async function getBundledExtensions(
  opts: { mobile?: boolean } = {}
): Promise<ExtensionManifest[]> {
  const active = ENTRIES.filter((e) => (opts.mobile ? e.mobile : true))
  return Promise.all(
    active.map(async ({ load, name, productName, description, version }) => {
      const { default: Ctor } = await load()
      return {
        name,
        productName,
        url: 'built-in',
        active: true,
        description,
        version,
        extensionInstance: new Ctor(
          'built-in',
          name,
          productName,
          true,
          description,
          version
        ),
      }
    })
  )
}
