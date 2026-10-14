import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostActionsApi } from '../hostActions'
import { clearComposeSkills, takeComposeSkills } from '@/lib/pendingComposeSkills'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'

const expert = { id: 'expert', available: true }
const needsModel = { id: 'cold', available: false, unavailableReason: 'agent_model_required' }
const skill = {
  id: 'writer',
  name: 'writer',
  display_name: 'Writer',
  description: '',
  version: '1',
  origin: 'plugin',
}
const disabledSkill = {
  id: 'off',
  name: 'off',
  display_name: 'Off',
  description: '',
  version: '1',
  origin: 'plugin',
  assignable: false,
}

const identity = (targetId: string, runtimeEpoch = 'e') => ({ targetId, runtimeEpoch })

const invokeSequence = (...responses: unknown[]) => {
  const invoke = vi.fn()
  for (const response of responses) invoke.mockResolvedValueOnce(response)
  return invoke
}

const api = (invoke: ReturnType<typeof vi.fn>, navigate = vi.fn()) => ({
  navigate,
  actions: createHostActionsApi({ navigate: navigate as never }, invoke as never),
})

const agentTarget = (id: string) => ({ namespace: 'runtime', type: 'agent', id })

beforeEach(() => {
  localStorage.clear()
  clearComposeSkills()
  usePrompt.setState({ prompt: '' })
  useThreads.setState({ currentThreadId: undefined })
})

describe('宿主级动作', () => {
  it('未知动作被拒绝，不会落到任何实现上', async () => {
    const invoke = invokeSequence()
    const { actions, navigate } = api(invoke)
    await expect(actions.invoke('surface.open' as never, {} as never)).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'UNSUPPORTED' },
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('不认识的资源引用按非法输入拒绝，不导航', async () => {
    const invoke = invokeSequence()
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.create', {
        target: { namespace: 'runtime', type: 'session', id: 'x' },
      })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } })
    expect(invoke).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('不带目标时只开一个新会话', async () => {
    const invoke = invokeSequence()
    const { actions, navigate } = api(invoke)
    await expect(actions.invoke('conversation.create', {})).resolves.toEqual({ status: 'completed' })
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('指定专家时写入新会话的预选并进入会话', async () => {
    const invoke = invokeSequence(identity('worker'), [expert, needsModel], identity('worker'))
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.create', { target: agentTarget('expert') })
    ).resolves.toEqual({ status: 'completed' })
    expect(localStorage.getItem('bibit:agent:worker')).toBe('expert')
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: false })
  })

  it('还需要选模型的专家按可用处理，与挑选器保持一致', async () => {
    const invoke = invokeSequence(identity('worker'), [needsModel], identity('worker'))
    const { actions } = api(invoke)
    await expect(
      actions.invoke('conversation.create', { target: agentTarget('cold') })
    ).resolves.toEqual({ status: 'completed' })
    expect(localStorage.getItem('bibit:agent:worker')).toBe('cold')
  })

  it('专家不存在时拒绝，且不写入预选、不导航', async () => {
    const invoke = invokeSequence(identity('worker'), [expert], identity('worker'))
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.create', { target: agentTarget('gone') })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } })
    expect(localStorage.getItem('bibit:agent:worker')).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('核对期间目标被切换时失败并可重试，不写入预选', async () => {
    const invoke = invokeSequence(identity('worker'), [expert], identity('other'))
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.create', { target: agentTarget('expert') })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'FAILED', retryable: true } })
    expect(localStorage.getItem('bibit:agent:worker')).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('没有可用目标时失败，不导航', async () => {
    const invoke = invokeSequence(identity(''))
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.create', { target: agentTarget('expert') })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'FAILED' } })
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('conversation.compose', () => {
  const skillTarget = (id: string) => ({ namespace: 'runtime', type: 'skill', id })

  it('只带提示词时预填草稿并新建会话，不发送', async () => {
    const invoke = invokeSequence()
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', { prompt: '帮我写一段开场白' })
    ).resolves.toEqual({ status: 'completed' })
    expect(usePrompt.getState().prompt).toBe('帮我写一段开场白')
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: false })
    // 只预置、不发送：不碰任何 Runtime 命令。
    expect(invoke).not.toHaveBeenCalled()
  })

  it('预选技能交给新会话输入框，取走即清', async () => {
    const invoke = invokeSequence(identity('worker'), [skill], identity('worker'))
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', {
        skills: [skillTarget('writer')],
        prompt: 'draft',
      })
    ).resolves.toEqual({ status: 'completed' })
    expect(takeComposeSkills('worker')).toMatchObject([{ id: 'writer' }])
    expect(takeComposeSkills('worker')).toEqual([])
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: false })
  })

  it('同时预选专家和技能', async () => {
    const invoke = invokeSequence(identity('worker'), [expert], [skill], identity('worker'))
    const { actions } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', {
        target: agentTarget('expert'),
        skills: [skillTarget('writer')],
      })
    ).resolves.toEqual({ status: 'completed' })
    expect(localStorage.getItem('bibit:agent:worker')).toBe('expert')
    expect(takeComposeSkills('worker')).toMatchObject([{ id: 'writer' }])
  })

  it('技能不可分配时拒绝，不写任何状态也不导航', async () => {
    const invoke = invokeSequence(identity('worker'), [disabledSkill], identity('worker'))
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', {
        skills: [skillTarget('off')],
        prompt: 'draft',
      })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } })
    expect(usePrompt.getState().prompt).toBe('')
    expect(takeComposeSkills('worker')).toEqual([])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('技能引用类型不认识时按非法输入拒绝，不触碰 Runtime', async () => {
    const invoke = invokeSequence()
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', {
        skills: [{ namespace: 'runtime', type: 'tool', id: 'x' }],
      })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } })
    expect(invoke).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('提示词超长按非法输入拒绝', async () => {
    const invoke = invokeSequence()
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', { prompt: 'x'.repeat(16_001) })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } })
    expect(usePrompt.getState().prompt).toBe('')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('技能数量超上限按非法输入拒绝', async () => {
    const invoke = invokeSequence()
    const { actions } = api(invoke)
    const skills = Array.from({ length: 101 }, (_, index) => skillTarget(`s${index}`))
    await expect(
      actions.invoke('conversation.compose', { skills })
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('首页有未发送草稿时拒绝，不覆盖也不导航', async () => {
    usePrompt.setState({ prompt: 'half written' })
    const invoke = invokeSequence()
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', { prompt: 'from plugin' })
    ).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'FAILED', retryable: true },
    })
    expect(usePrompt.getState().prompt).toBe('half written')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('会话内的草稿按会话落盘，覆盖后可恢复', async () => {
    usePrompt.setState({ prompt: 'session draft' })
    useThreads.setState({ currentThreadId: 's1' })
    const invoke = invokeSequence()
    const { actions } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', { prompt: 'from plugin' })
    ).resolves.toEqual({ status: 'completed' })
    expect(usePrompt.getState().prompt).toBe('from plugin')
  })

  it('核对期间目标被切换时失败并可重试，不写状态', async () => {
    const invoke = invokeSequence(identity('worker'), [skill], identity('other'))
    const { actions, navigate } = api(invoke)
    await expect(
      actions.invoke('conversation.compose', {
        skills: [skillTarget('writer')],
        prompt: 'draft',
      })
    ).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'FAILED', retryable: true },
    })
    expect(usePrompt.getState().prompt).toBe('')
    expect(takeComposeSkills('worker')).toEqual([])
    expect(navigate).not.toHaveBeenCalled()
  })
})
