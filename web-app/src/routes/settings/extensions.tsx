import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'

import SettingsMenu from '@/containers/SettingsMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  ActiveTrustedPluginListV1,
  ActiveTrustedPluginV1,
  TrustedPluginLifecycleV1,
  RejectedTrustedPluginV1,
} from '@/features/host/trustedPluginLoader'

const PLUGIN_STATUS_KEYS: Record<string, string> = {
  active: 'settings:pluginStatus.active',
  'rollback-available': 'settings:pluginStatus.rollbackAvailable',
  'pending-restart': 'settings:pluginStatus.pendingRestart',
  'pending-cleanup': 'settings:pluginStatus.pendingCleanup',
  disabled: 'settings:pluginStatus.disabled',
  recovered: 'settings:pluginStatus.recovered',
  rejected: 'settings:pluginStatus.rejected',
}

const restartAfterLifecycleChange = async () => {
  await invoke('relaunch')
}

type PendingPluginAction = {
  id: string
  title: string
  kind: 'deactivate' | 'uninstall'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.extensions as any)({
  component: ExtensionsContent,
})

function ExtensionsContent() {
  const { t } = useTranslation()
  const featureTitle = (manifest: ActiveTrustedPluginV1['featureManifest']) => {
    const { titleKey, fallbackTitle } = manifest.display
    const translated = t(titleKey)
    return translated === titleKey ? fallbackTitle : translated
  }
  const statusLabel = (status: string) => {
    const key = PLUGIN_STATUS_KEYS[status]
    return key ? t(key) : status
  }
  const serviceHub = useServiceHub()
  const [plugins, setPlugins] = useState<readonly ActiveTrustedPluginV1[]>([])
  const [rejectedPlugins, setRejectedPlugins] = useState<
    readonly RejectedTrustedPluginV1[]
  >([])
  const [lifecycle, setLifecycle] = useState<
    readonly TrustedPluginLifecycleV1[]
  >([])
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingPluginAction | null>(
    null
  )
  useEffect(() => {
    void invoke<ActiveTrustedPluginListV1>('trusted_plugin_list_active')
      .then(({ plugins: active, rejected, lifecycle: states }) => {
        setPlugins(active)
        setRejectedPlugins(rejected)
        setLifecycle(states ?? [])
      })
      .catch(() => {
        setPlugins([])
        setRejectedPlugins([])
        setLifecycle([])
      })
  }, [])

  const installPlugin = async () => {
    const bundlePath = await serviceHub.dialog().open({
      multiple: false,
      filters: [{ name: t('settings:pluginBundleFilter'), extensions: ['tgz'] }],
    })
    if (typeof bundlePath !== 'string') return
    setBusy(true)
    try {
      await invoke<ActiveTrustedPluginV1>('trusted_plugin_install', {
        bundlePath,
        activate: true,
      })
      await restartAfterLifecycleChange()
    } catch (error) {
      toast.error(String(error))
      setBusy(false)
    }
  }

  const deactivatePlugin = async (id: string) => {
    setBusy(true)
    try {
      await invoke('trusted_plugin_deactivate', { id })
      await restartAfterLifecycleChange()
    } catch (error) {
      toast.error(String(error))
      setBusy(false)
    }
  }

  const activatePlugin = async (id: string, version: string) => {
    setBusy(true)
    try {
      await invoke('trusted_plugin_activate', { id, version })
      await restartAfterLifecycleChange()
    } catch (error) {
      toast.error(String(error))
      setBusy(false)
    }
  }

  const rollbackPlugin = async (id: string) => {
    setBusy(true)
    try {
      await invoke('trusted_plugin_rollback', { id })
      await restartAfterLifecycleChange()
    } catch (error) {
      toast.error(String(error))
      setBusy(false)
    }
  }

  const uninstallPlugin = async (id: string) => {
    setBusy(true)
    try {
      await invoke('trusted_plugin_uninstall', { id })
      await restartAfterLifecycleChange()
    } catch (error) {
      toast.error(String(error))
      setBusy(false)
    }
  }

  const confirmPendingAction = async () => {
    const action = pendingAction
    if (!action) return
    setPendingAction(null)
    if (action.kind === 'uninstall') {
      await uninstallPlugin(action.id)
    } else {
      await deactivatePlugin(action.id)
    }
  }

  const pendingKind = pendingAction?.kind ?? 'deactivate'
  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className='font-medium text-base font-studio'>{t('common:settings')}</span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full md:w-4/5 xl:w-4/6 mx-auto">
            <Card
              header={
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h1 className="text-foreground font-studio font-medium text-base">
                      {t('settings:trustedPlugins')}
                    </h1>
                    <p className="text-muted-foreground text-sm">
                      {t('settings:trustedPluginsDesc')}
                    </p>
                  </div>
                  <Button size="sm" disabled={busy} onClick={installPlugin}>
                    {t('settings:installPlugin')}
                  </Button>
                </div>
              }
            >
              {plugins.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('settings:noActivePlugins')}</p>
              ) : (
                plugins.map((plugin) => {
                  const state = lifecycle.find((item) => item.id === plugin.id)
                  return (
                    <CardItem
                      key={plugin.id}
                      title={`${featureTitle(plugin.featureManifest)} v${plugin.version}`}
                      description={`${plugin.id} · ${statusLabel(state?.status ?? 'active')}`}
                      actions={
                        <div className="flex items-center gap-2">
                          {state?.previousVersion ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => rollbackPlugin(plugin.id)}
                            >
                              {t('settings:rollBack')}
                            </Button>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              setPendingAction({
                                id: plugin.id,
                                title: `${featureTitle(plugin.featureManifest)} v${plugin.version}`,
                                kind: 'deactivate',
                              })
                            }
                          >
                            {t('settings:deactivate')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              setPendingAction({
                                id: plugin.id,
                                title: `${featureTitle(plugin.featureManifest)} v${plugin.version}`,
                                kind: 'uninstall',
                              })
                            }
                          >
                            {t('settings:uninstallPlugin')}
                          </Button>
                        </div>
                      }
                    />
                  )
                })
              )}
              {rejectedPlugins.map((plugin) => (
                <CardItem
                  key={`rejected:${plugin.id}`}
                  title={`${plugin.id} v${plugin.version}`}
                  description={t('settings:pluginRejected', { code: plugin.code, reason: plugin.reason })}
                  actions={
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setPendingAction({
                            id: plugin.id,
                            title: `${plugin.id} v${plugin.version}`,
                            kind: 'deactivate',
                          })
                        }
                      >
                        {t('settings:deactivate')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setPendingAction({
                            id: plugin.id,
                            title: `${plugin.id} v${plugin.version}`,
                            kind: 'uninstall',
                          })
                        }
                      >
                        {t('settings:uninstallPlugin')}
                      </Button>
                    </div>
                  }
                />
              ))}
              {lifecycle
                .filter(
                  ({ status }) =>
                    !['active', 'rollback-available', 'rejected'].includes(status)
                )
                .map((plugin) => (
                  <CardItem
                    key={`lifecycle:${plugin.id}:${plugin.version}`}
                    title={`${plugin.id} v${plugin.version}`}
                    description={`${statusLabel(plugin.status)}${plugin.code ? ` (${plugin.code})` : ''}${plugin.reason ? `: ${plugin.reason}` : ''}`}
                    actions={
                      plugin.status === 'disabled' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => activatePlugin(plugin.id, plugin.version)}
                        >
                          {t('settings:activate')}
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
            </Card>
          </div>
        </div>
      </div>
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                pendingKind === 'uninstall'
                  ? 'settings:pluginAction.uninstallTitle'
                  : 'settings:pluginAction.deactivateTitle'
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                pendingKind === 'uninstall'
                  ? 'settings:pluginAction.uninstallDescription'
                  : 'settings:pluginAction.deactivateDescription',
                { plugin: pendingAction?.title ?? '' }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" className="w-full sm:w-auto">
                {t('common:cancel')}
              </Button>
            </DialogClose>
            <Button
              variant={pendingKind === 'uninstall' ? 'destructive' : 'default'}
              size="sm"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={() => void confirmPendingAction()}
            >
              {t(
                pendingKind === 'uninstall'
                  ? 'settings:pluginAction.confirmUninstall'
                  : 'settings:pluginAction.confirmDeactivate'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
