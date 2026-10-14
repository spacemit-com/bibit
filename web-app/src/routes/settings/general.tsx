import { createFileRoute } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useEffect, useState } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  IconFolder,
  IconLogs,
  IconCopy,
} from '@tabler/icons-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import LanguageSwitcher from '@/containers/LanguageSwitcher'
import VoiceSettingsCard from '@/containers/VoiceSettingsCard'

type DesktopIntegrationStatus = {
  residentEnabled: boolean
  autostartEnabled: boolean
  autostartRegistered: boolean
  popupGeometry: PopupGeometry
}

type PopupGeometry = {
  screenIndex: number
  width: number
  height: number
  rightMargin: number
  bottomMargin: number
}

type DeliveryInformation = {
  productVersion: string
  buildVersion: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.general as any)({
  component: General,
})

function General() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const openFileTitle = (): string => {
    return t('settings:general.openContainingFolder')
  }
  const [janDataFolder, setJanDataFolder] = useState<string | undefined>()
  const [desktopIntegration, setDesktopIntegration] =
    useState<DesktopIntegrationStatus | null>(null)
  const [desktopIntegrationLoading, setDesktopIntegrationLoading] =
    useState(false)
  const [popupGeometry, setPopupGeometry] = useState<PopupGeometry | null>(null)
  const [deliveryInformation, setDeliveryInformation] =
    useState<DeliveryInformation>({
      productVersion: IS_TAURI ? '' : VERSION.replace('1.0.0-beta.1', '1.0Beta1'),
      buildVersion: IS_TAURI ? '' : 'development',
    })

  useEffect(() => {
    const fetchDataFolder = async () => {
      const path = await serviceHub.app().getJanDataFolder()
      setJanDataFolder(path)
    }

    fetchDataFolder()
  }, [serviceHub])

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<DeliveryInformation>('get_delivery_information')
      .then(setDeliveryInformation)
      .catch((error) =>
        toast.error(t('settings:general.deliveryInfoError'), {
          description: String(error),
        })
      )
  }, [t])

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<DesktopIntegrationStatus>('desktop_integration_status')
      .then((status) => {
        setDesktopIntegration(status)
        setPopupGeometry(status.popupGeometry)
      })
      .catch((error) =>
        toast.error(t('settings:general.desktopIntegrationError'), {
          description: String(error),
        })
      )
  }, [t])

  const updateDesktopIntegration = async (
    command:
      | 'desktop_integration_set_resident'
      | 'desktop_integration_set_autostart',
    enabled: boolean
  ) => {
    setDesktopIntegrationLoading(true)
    try {
      const status = await invoke<DesktopIntegrationStatus>(command, {
        enabled,
      })
      setDesktopIntegration(status)
      toast.success(t('settings:general.desktopIntegrationSaved'))
    } catch (error) {
      toast.error(t('settings:general.desktopIntegrationError'), {
        description: String(error),
      })
    } finally {
      setDesktopIntegrationLoading(false)
    }
  }

  const savePopupGeometry = async () => {
    if (!desktopIntegration || !popupGeometry) return
    setDesktopIntegrationLoading(true)
    try {
      const status = await invoke<DesktopIntegrationStatus>(
        'desktop_integration_set_popup_geometry',
        popupGeometry
      )
      setDesktopIntegration(status)
      setPopupGeometry(status.popupGeometry)
      toast.success(t('settings:general.popupGeometrySaved'))
    } catch (error) {
      setPopupGeometry(desktopIntegration.popupGeometry)
      toast.error(t('settings:general.popupGeometryError'), {
        description: String(error),
      })
    } finally {
      setDesktopIntegrationLoading(false)
    }
  }

  const handleOpenLogs = async () => {
    try {
      await serviceHub.window().openLogsWindow()
    } catch (error) {
      console.error('Failed to open logs window:', error)
    }
  }

  const copyDeliveryVersion = async () => {
    try {
      await navigator.clipboard.writeText(
        `BiBit ${deliveryInformation.productVersion}\n${deliveryInformation.buildVersion}`
      )
      toast.success(t('settings:general.versionCopied'))
    } catch (error) {
      toast.error(t('settings:general.copyVersionError'), {
        description: String(error),
      })
    }
  }

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

            {/* General */}
            <Card title={t('common:general')}>
              <CardItem
                title={t('settings:general.appVersion')}
                actions={
                  <div className="flex items-center gap-2">
                    <span className="text-foreground font-medium">
                      {deliveryInformation.productVersion
                        ? `v${deliveryInformation.productVersion}`
                        : '—'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {deliveryInformation.buildVersion || '—'}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('settings:general.copyVersion')}
                      disabled={
                        !deliveryInformation.productVersion ||
                        !deliveryInformation.buildVersion
                      }
                      onClick={() => void copyDeliveryVersion()}
                    >
                      <IconCopy size={14} />
                    </Button>
                  </div>
                }
              />
              <CardItem
                title={t('common:language')}
                actions={<LanguageSwitcher />}
              />
            </Card>

            {IS_TAURI && desktopIntegration && (
              <Card title={t('settings:general.desktopIntegration')}>
                <CardItem
                  title={t('settings:general.residentMode')}
                  description={t('settings:general.residentModeDesc')}
                  className="items-center flex-row gap-y-2"
                  actions={
                    <Switch
                      aria-label={t('settings:general.residentMode')}
                      checked={desktopIntegration.residentEnabled}
                      disabled={desktopIntegrationLoading}
                      onCheckedChange={(enabled) =>
                        updateDesktopIntegration(
                          'desktop_integration_set_resident',
                          enabled
                        )
                      }
                    />
                  }
                />
                <CardItem
                  title={t('settings:general.autostart')}
                  description={t('settings:general.autostartDesc')}
                  className="items-center flex-row gap-y-2"
                  actions={
                    <Switch
                      aria-label={t('settings:general.autostart')}
                      checked={
                        desktopIntegration.autostartEnabled &&
                        desktopIntegration.autostartRegistered
                      }
                      disabled={
                        desktopIntegrationLoading ||
                        !desktopIntegration.residentEnabled
                      }
                      onCheckedChange={(enabled) =>
                        updateDesktopIntegration(
                          'desktop_integration_set_autostart',
                          enabled
                        )
                      }
                    />
                  }
                />
                {popupGeometry && (
                  <CardItem
                    title={t('settings:general.popupGeometry')}
                    description={t('settings:general.popupGeometryDesc')}
                    className="items-center flex-row gap-y-2"
                    actions={
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {(
                          [
                            ['width', 'popupWidth'],
                            ['height', 'popupHeight'],
                          ] as const
                        ).map(([field, label]) => (
                          <Input
                            key={field}
                            type="number"
                            aria-label={t(`settings:general.${label}`)}
                            className="h-8 w-20"
                            min={field === 'width' ? 300 : 400}
                            max={field === 'width' ? 600 : 800}
                            value={popupGeometry[field]}
                            disabled={desktopIntegrationLoading}
                            onChange={(event) =>
                              setPopupGeometry({
                                ...popupGeometry,
                                [field]: Number(event.target.value),
                              })
                            }
                          />
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={desktopIntegrationLoading}
                          onClick={() => void savePopupGeometry()}
                        >
                          {t('common:save')}
                        </Button>
                      </div>
                    }
                  />
                )}
              </Card>
            )}

            {/* Voice - Desktop only */}
            {IS_TAURI && <VoiceSettingsCard />}

            <Card title={t('settings:dataFolder.appLogs')}>
              <CardItem
                title={t('settings:dataFolder.appLogs', {
                  ns: 'settings',
                })}
                description={t('settings:dataFolder.appLogsDesc')}
                className="items-start flex-row gap-y-2"
                actions={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="p-0"
                      onClick={async () => {
                        if (janDataFolder) {
                          try {
                            const logsPath = await serviceHub.path().join(
                              janDataFolder,
                              'logs'
                            )
                            await serviceHub.opener().revealItemInDir(logsPath)
                          } catch (error) {
                            console.error(
                              'Failed to reveal logs folder:',
                              error
                            )
                          }
                        }
                      }}
                      title={t('settings:general.revealLogs')}
                    >
                      <IconFolder
                        size={12}
                        className="text-muted-foreground"
                      />
                      <span>{openFileTitle()}</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleOpenLogs}
                      title={t('settings:dataFolder.appLogs')}
                    >
                      <IconLogs size={12} className="text-muted-foreground" />
                      <span>{t('settings:general.openLogs')}</span>
                    </Button>
                  </div>
                }
              />
            </Card>

          </div>
        </div>
      </div>
    </div>
  )
}
