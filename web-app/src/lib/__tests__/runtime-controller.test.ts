import { expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
import { withRuntimeController } from '../runtime-controller'

it('未取得租约不执行操作，获取失败后下一次可重试', async () => {
  invoke.mockReset().mockResolvedValueOnce({ accepted: false })
  const operation = vi.fn().mockResolvedValue('ok')
  await expect(withRuntimeController(operation)).rejects.toThrow('Another Bibit client is using this workbench')
  expect(operation).not.toHaveBeenCalled()
  invoke.mockResolvedValueOnce({ accepted: true, duplicate: false }).mockResolvedValueOnce({})
  await expect(withRuntimeController(operation)).resolves.toBe('ok')
})

it('借用已有窗口租约时不释放，操作失败仍保留原始错误', async () => {
  invoke.mockReset().mockResolvedValue({ accepted: true, duplicate: true })
  await expect(withRuntimeController(async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('释放尚未结束时新请求等待，释放失败不覆盖已确认结果', async () => {
  let release!: () => void
  invoke.mockReset().mockImplementation(async name => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    await new Promise<void>(resolve => { release = resolve })
    throw new Error('release failed')
  })
  const first = withRuntimeController(async () => 'first')
  await vi.waitFor(() => expect(release).toBeDefined())
  const operation = vi.fn().mockResolvedValue('second')
  const second = withRuntimeController(operation)
  await Promise.resolve()
  expect(operation).not.toHaveBeenCalled()
  release()
  await expect(first).resolves.toBe('first')
  await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())
  release()
  await expect(second).resolves.toBe('second')
})
