import type {
  FeatureModuleV1,
  PermissionPresenterProps,
} from '@bibit/feature-sdk'
import { useState } from 'react'
import { Button, FeatureSettingsPage } from '@bibit/feature-ui'

type SecurityRule = {
  id: string
  title: string
  description: string
  enabled: boolean
}

const initialRules: readonly SecurityRule[] = [
  {
    id: 'ssh-key',
    title: '读取 SSH 私钥',
    description: '访问 ~/.ssh、GPG 私钥或其他身份凭据时必须确认',
    enabled: true,
  },
  {
    id: 'shell',
    title: '执行系统命令',
    description: 'Agent 调用 Shell、终端或系统管理命令时必须确认',
    enabled: true,
  },
  {
    id: 'network',
    title: '向外部服务发送数据',
    description: '上传文件或向未信任域名发送对话内容时必须确认',
    enabled: false,
  },
]

function SecurityRulesSettings() {
  const [rules, setRules] = useState(() =>
    initialRules.map((rule) => ({ ...rule }))
  )
  const [savedRules, setSavedRules] = useState(() =>
    initialRules.map((rule) => ({ ...rule }))
  )
  const [saved, setSaved] = useState(false)
  const dirty = rules.some(
    (rule, index) => rule.enabled !== savedRules[index]?.enabled
  )

  return (
    <FeatureSettingsPage
      title="Agent 安全规则"
      description="此页面由模拟 Security Feature 提供，宿主只负责路由、导航和生命周期。"
    >
      <div className="space-y-3">
        {rules.map((rule) => (
          <label
            key={rule.id}
            className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border bg-card p-4"
          >
            <span className="space-y-1">
              <span className="block font-medium">{rule.title}</span>
              <span className="block text-sm text-muted-foreground">
                {rule.description}
              </span>
            </span>
            <input
              type="checkbox"
              aria-label={rule.title}
              checked={rule.enabled}
              className="mt-1 size-4 accent-primary"
              onChange={(event) => {
                setSaved(false)
                setRules((current) =>
                  current.map((item) =>
                    item.id === rule.id
                      ? { ...item, enabled: event.target.checked }
                      : item
                  )
                )
              }}
            />
          </label>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between gap-4 border-t pt-4">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {dirty
            ? '存在未保存的更改'
            : saved
              ? '规则已保存到模拟安全服务'
              : '当前规则已同步'}
        </p>
        <Button
          disabled={!dirty}
          className="bg-primary text-primary-foreground"
          onClick={() => {
            setSavedRules(rules.map((rule) => ({ ...rule })))
            setSaved(true)
          }}
        >
          保存规则
        </Button>
      </div>
    </FeatureSettingsPage>
  )
}

function SecurityPermissionPresenter({
  request,
  decide,
  viewState,
}: PermissionPresenterProps) {
  const identity = {
    runtimeInstanceId: request.runtimeInstanceId,
    runtimeId: request.runtimeId,
    runtimeEpoch: request.runtimeEpoch,
    sessionId: request.sessionId,
    threadId: request.threadId,
    runId: request.runId,
    requestId: request.requestId,
    toolCallId: request.toolCallId,
  }
  return (
    <section
      role="dialog"
      aria-labelledby="security-permission-title"
      className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">
        Security Feature · 高风险操作
      </p>
      <h2 id="security-permission-title" className="mt-2 font-semibold">
        Agent 请求额外权限
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {request.action.summary}
      </p>
      {request.action.details ? (
        <pre className="mt-3 overflow-auto rounded-lg bg-muted p-3 text-xs">
          {JSON.stringify(request.action.details, null, 2)}
        </pre>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        {request.supportedDecisions.includes('deny') ? (
          <Button
            aria-label="Deny"
            className="border"
            disabled={viewState.status === 'submitting' || viewState.status === 'resolved'}
            onClick={() =>
              void decide({
                version: 1,
                ...identity,
                decision: 'deny',
                reason: 'user-denied',
              })
            }
          >
            拒绝
          </Button>
        ) : null}
        {request.supportedDecisions.includes('allow_once') ? (
          <Button
            aria-label="Allow once"
            autoFocus
            className="bg-primary text-primary-foreground"
            disabled={viewState.status === 'submitting' || viewState.status === 'resolved'}
            onClick={() =>
              void decide({
                version: 1,
                ...identity,
                decision: 'allow_once',
              })
            }
          >
            仅允许本次
          </Button>
        ) : null}
      </div>
    </section>
  )
}

export const featureModule: FeatureModuleV1 = {
  sdkApiVersion: 1,
  settings: { rules: SecurityRulesSettings },
  permissionPresenters: { approval: SecurityPermissionPresenter },
  locales: {
    en: { title: 'Security', description: 'Review agent permission requests' },
    'zh-CN': { title: '安全', description: '审查 Agent 权限请求' },
  },
}

export default featureModule
