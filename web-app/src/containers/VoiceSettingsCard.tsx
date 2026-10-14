import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  beginSwitchIntent,
  beginVoiceSwitch,
  clearSwitchIntent,
  isVoiceTransportError,
  recordVoiceStatus,
  recordVoiceStatusUnavailable,
  useVoiceServiceState,
  useVoiceStatusStore,
  VOICE_SERVICE_MESSAGE_KEYS,
  type VoiceStatus,
} from '@/stores/voice-status-store'
import { cn } from '@/lib/utils'
import { ChevronsUpDown } from 'lucide-react'

const ASR_MODELS = [
  { value: 'sensevoice', key: 'settings:general.asrModelSensevoice' },
  { value: 'qwen3_asr_0.6b', key: 'settings:general.asrModelQwen3' },
] as const

const SWITCH_ERROR_KEYS: Record<string, string> = {
  ASR_MODEL_SWITCH_FAILED: 'settings:general.voiceSwitchFailed',
  ASR_MODEL_FILES_MISSING: 'settings:general.voiceSwitchFilesMissing',
  ASR_MODEL_PERSIST_FAILED: 'settings:general.voiceSwitchPersistFailed',
  ASR_INIT_FAILED: 'settings:general.voiceSwitchInitFailed',
  UNSUPPORTED_ASR_MODEL: 'settings:general.voiceSwitchUnsupported',
  SWITCH_UNCONFIRMED: 'settings:general.voiceSwitchTimeout',
  SWITCH_PERSIST_FAILED: 'settings:general.voiceSwitchPersistWarning',
  AUDIO_OPEN_FAILED: 'settings:general.voiceAudioOpenFailed',
}

export default function VoiceSettingsCard() {
  const { t } = useTranslation()
  // 状态由 VoiceStatusBridge 统一订阅与探测，本卡片只做投影渲染。
  const status = useVoiceStatusStore((state) => state.status)
  const switching = useVoiceStatusStore((state) => state.switching)
  const switchError = useVoiceStatusStore((state) => state.switchError)
  const switchIntent = useVoiceStatusStore((state) => state.switchIntent)
  const serviceState = useVoiceServiceState()
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState('')

  const activeModel =
    ASR_MODELS.find((model) => model.value === status?.asr_model_type) ?? ASR_MODELS[0]
  const targetModel = ASR_MODELS.find((model) => model.value === switching?.target)
  // 开关按字段提交意图，两个开关各自乐观显示，因此在途时不再禁用：
  // 禁用只会把连点变成「点了没反应」。引擎下拉仍按既有规则在切换期间禁用。
  const serviceUnavailable = !status || serviceState === 'offline'
  const wakeChecked = switchIntent?.wake?.value ?? status?.wake ?? false
  const asrChecked = switchIntent?.asr?.value ?? status?.asr ?? false
  const switchApplying = !!switchIntent
  // 跨版本：只认服务端声明的能力位，不去猜「有没有 desired」这种实现细节。
  // 旧服务端对缺失字段取默认 true，只发一个字段会把它当作「另一个开关也要打开」，
  // 所以不支持字段级提交的服务端必须退回全量提交。
  const supportsFieldIntents = status?.partial_switches === true

  const noteInvokeFailure = (error: unknown) => {
    const message = String(error)
    setErrorText(message)
    // 连接层失败要落到服务可用性上；会话级错误保持原文，别被一句"未连接"盖掉。
    if (isVoiceTransportError(message)) {
      recordVoiceStatusUnavailable()
      return
    }
    // 未确认（例如命令超时）：保持现有状态，读一次快照对账，不假装服务掉线。
    void invoke<VoiceStatus>('voice_tool_get_status')
      .then((snapshot) => recordVoiceStatus(snapshot))
      .catch(() => {})
  }

  // 只提交被点击的字段 + request_id：不再用可能过期的快照拼装另一个开关。
  const sendSwitchIntent = async (field: 'wake' | 'asr', enabled: boolean) => {
    const requestId = `sw-${Date.now().toString(36)}-${field}`
    beginSwitchIntent(field, enabled, requestId)
    setErrorText('')
    const payload: Record<string, unknown> = supportsFieldIntents
      // Tauri 命令参数按 camelCase 映射（本仓库既有约定），传 request_id 会被
      // 当成「未提供」静默丢弃，关联链路会整条断掉。
      ? { [field]: enabled, requestId }
      : {
          wake: field === 'wake' ? enabled : (status?.wake ?? false),
          asr: field === 'asr' ? enabled : (status?.asr ?? false),
        }
    try {
      await invoke('voice_tool_set_switches', payload)
    } catch (error) {
      noteInvokeFailure(error)
      clearSwitchIntent(field)
    }
  }

  const setModel = async (model: string) => {
    // 幂等：已经是生效引擎就不发命令（服务端也会按成功 no-op 处理）。
    if (model === status?.asr_model_type && !switching) return
    beginVoiceSwitch(model)
    setBusy(true)
    setErrorText('')
    try {
      await invoke('voice_tool_set_asr_model', { model })
    } catch (error) {
      noteInvokeFailure(error)
    } finally {
      setBusy(false)
    }
  }

  // 切换中比"模型加载中"更具体，优先说目标引擎；连接层错误在 ready 时顶掉常规文案。
  const serviceDescription = switching
    ? t('settings:general.voiceSwitching', {
        model: t(targetModel?.key ?? activeModel.key),
      })
    : switchApplying
      ? t('settings:general.voiceSwitchApplying')
    : errorText && serviceState === 'ready'
      ? errorText
      : t(VOICE_SERVICE_MESSAGE_KEYS[serviceState])

  // 服务端报回来的切换失败要带上原因；连接层失败已经由描述行说明，不重复告警。
  const switchAlert = switchError
    ? t(SWITCH_ERROR_KEYS[switchError.code] ?? 'settings:general.voiceSwitchFailed', {
        model: t(activeModel.key),
        reason: switchError.detail.trim() || t('settings:general.voiceSwitchNoReason'),
      })
    : ''

  return (
    <Card title={t('settings:general.voice')}>
      {switchAlert && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {switchAlert}
        </p>
      )}
      <CardItem
        title={t('settings:general.voiceService')}
        description={serviceDescription}
        className="items-center flex-row gap-y-2"
      />
      <CardItem
        title={t('settings:general.wakeSwitch')}
        description={t('settings:general.wakeSwitchDesc')}
        className="items-center flex-row gap-y-2"
        actions={
          <Switch
            aria-label={t('settings:general.wakeSwitch')}
            checked={wakeChecked}
            disabled={serviceUnavailable}
            aria-busy={!!switchIntent?.wake}
            onCheckedChange={(enabled) => sendSwitchIntent('wake', enabled)}
          />
        }
      />
      <CardItem
        title={t('settings:general.asrSwitch')}
        description={t('settings:general.asrSwitchDesc')}
        className="items-center flex-row gap-y-2"
        actions={
          <Switch
            aria-label={t('settings:general.asrSwitch')}
            checked={asrChecked}
            disabled={serviceUnavailable}
            aria-busy={!!switchIntent?.asr}
            onCheckedChange={(enabled) => sendSwitchIntent('asr', enabled)}
          />
        }
      />
      <CardItem
        title={t('settings:general.asrModel')}
        description={t('settings:general.asrModelDesc')}
        className="items-center flex-row gap-y-2"
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between"
                disabled={serviceUnavailable || busy || !!switching}
                aria-busy={!!switching}
              >
                {switching && targetModel
                  ? t(targetModel.key)
                  : t(activeModel.key)}
                {switching && (
                  <span
                    className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent"
                    aria-hidden="true"
                  />
                )}
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {ASR_MODELS.map((model) => (
                <DropdownMenuItem
                  key={model.value}
                  className={cn(
                    'cursor-pointer my-0.5',
                    (switching?.target ?? status?.asr_model_type) === model.value &&
                      'bg-secondary-foreground/8'
                  )}
                  onClick={() => setModel(model.value)}
                >
                  {t(model.key)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
    </Card>
  )
}
