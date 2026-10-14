import { invoke } from '@tauri-apps/api/core'
import i18n from '@/i18n/setup'

type Lease = { accepted: boolean; duplicate: boolean }
let active: { users: number; ready: Promise<Lease> } | undefined
let releasing: Promise<unknown> = Promise.resolve()

/** 同一窗口的并发临时命令共享租约，最后一个完成后才释放。 */
export async function withRuntimeController<T>(operation: () => Promise<T>): Promise<T> {
  const lease = active ??= {
    users: 0,
    ready: releasing.then(async () => {
      const result = await invoke<Lease>('runtime_controller_acquire')
      if (!result.accepted) throw new Error(i18n.t('common:windowControlUnavailable'))
      return result
    }),
  }
  lease.users++
  try {
    await lease.ready
    return await operation()
  } finally {
    if (--lease.users === 0) {
      active = undefined
      releasing = lease.ready.then(async result => {
        if (!result.duplicate) await invoke('runtime_controller_release')
      }).catch(() => undefined)
      // 释放失败不能将已经确认成功的操作重新分类为失败。
      await releasing
    }
  }
}
