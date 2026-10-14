import { createFileRoute } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ShortcutAction, PlatformShortcuts, type ShortcutSpec } from '@/lib/shortcuts'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import HeaderPage from '@/containers/HeaderPage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.shortcuts as any)({
  component: Shortcuts,
})

interface ShortcutLabelProps {
  action: ShortcutAction
  className?: string
}

type DesktopIntegrationStatus = {
  residentEnabled: boolean
  globalShortcut: string
  globalShortcutRegistered: boolean
}

/**
 * Renders a keyboard shortcut label consistently across platforms
 */
function ShortcutLabel({ action, className = '' }: ShortcutLabelProps) {
  const spec = PlatformShortcuts[action]

  return (
    <KbdGroup className={className}>
      <ShortcutKeys spec={spec} />
    </KbdGroup>
  )
}

/**
 * Renders the key combination for a shortcut spec
 */
function ShortcutKeys({ spec }: { spec: ShortcutSpec }) {
  const parts: React.ReactNode[] = []

  // Helper function to format key names consistently
  const formatKey = (key: string) => {
    const lowerKey = key.toLowerCase()
    if (lowerKey === 'enter') return 'Enter'
    if (lowerKey === 'shift') return 'Shift'
    if (lowerKey === 'ctrl') return 'Ctrl'
    if (lowerKey === 'alt') return 'Alt'
    return key.toUpperCase()
  }

  // Add modifier keys
  if (spec.usePlatformMetaKey) {
    parts.push(<Kbd key="meta"><PlatformMetaKey /></Kbd>)
  }
  if (spec.ctrlKey) {
    parts.push(<Kbd key="ctrl">Ctrl</Kbd>)
  }
  if (spec.metaKey) {
    parts.push(<Kbd key="cmd">⌘</Kbd>)
  }
  if (spec.altKey) {
    parts.push(<Kbd key="alt">Alt</Kbd>)
  }
  if (spec.shiftKey) {
    parts.push(<Kbd key="shift">Shift</Kbd>)
  }

  // Add the main key with proper formatting
  parts.push(<Kbd key="main">{formatKey(spec.key)}</Kbd>)

  return <>{parts}</>
}

function Shortcuts() {
  const { t } = useTranslation()
  const [desktopIntegration, setDesktopIntegration] =
    useState<DesktopIntegrationStatus | null>(null)
  const [globalShortcut, setGlobalShortcut] = useState('Super+B')
  const [savingGlobalShortcut, setSavingGlobalShortcut] = useState(false)

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<DesktopIntegrationStatus>('desktop_integration_status')
      .then((status) => {
        setDesktopIntegration(status)
        setGlobalShortcut(status.globalShortcut)
      })
      .catch((error) =>
        toast.error(t('settings:shortcuts.globalShortcutError'), {
          description: String(error),
        })
      )
  }, [t])

  const saveGlobalShortcut = async () => {
    if (!desktopIntegration) return
    setSavingGlobalShortcut(true)
    try {
      const status = await invoke<DesktopIntegrationStatus>(
        'desktop_integration_set_global_shortcut',
        { shortcut: globalShortcut }
      )
      setDesktopIntegration(status)
      setGlobalShortcut(status.globalShortcut)
      toast.success(t('settings:shortcuts.globalShortcutSaved'))
    } catch (error) {
      setGlobalShortcut(desktopIntegration.globalShortcut)
      toast.error(t('settings:shortcuts.globalShortcutError'), {
        description: String(error),
      })
    } finally {
      setSavingGlobalShortcut(false)
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
            {IS_TAURI && desktopIntegration && (
              <Card title={t('settings:shortcuts.global')}>
                <CardItem
                  title={t('settings:shortcuts.globalShortcut')}
                  description={t(
                    desktopIntegration.residentEnabled
                      ? desktopIntegration.globalShortcutRegistered
                        ? 'settings:shortcuts.globalShortcutActiveDesc'
                        : 'settings:shortcuts.globalShortcutInactiveDesc'
                      : 'settings:shortcuts.globalShortcutResidentDisabledDesc'
                  )}
                  actions={
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={t('settings:shortcuts.globalShortcut')}
                        className="h-8 w-36"
                        value={globalShortcut}
                        disabled={savingGlobalShortcut}
                        onChange={(event) =>
                          setGlobalShortcut(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveGlobalShortcut()
                        }}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          savingGlobalShortcut || globalShortcut.trim().length === 0
                        }
                        onClick={saveGlobalShortcut}
                      >
                        {t('common:save')}
                      </Button>
                    </div>
                  }
                />
              </Card>
            )}

            {/* Application */}
            <Card title={t('settings:shortcuts.application')}>
              <CardItem
                title={t('settings:shortcuts.newChat')}
                description={t('settings:shortcuts.newChatDesc')}
                actions={<ShortcutLabel action={ShortcutAction.NEW_CHAT} />}
              />
              <CardItem
                title={t('settings:shortcuts.toggleSidebar')}
                description={t('settings:shortcuts.toggleSidebarDesc')}
                actions={<ShortcutLabel action={ShortcutAction.TOGGLE_SIDEBAR} />}
              />
              <CardItem
                title={t('settings:shortcuts.zoomIn')}
                description={t('settings:shortcuts.zoomInDesc')}
                actions={<ShortcutLabel action={ShortcutAction.ZOOM_IN} />}
              />
              <CardItem
                title={t('settings:shortcuts.zoomOut')}
                description={t('settings:shortcuts.zoomOutDesc')}
                actions={<ShortcutLabel action={ShortcutAction.ZOOM_OUT} />}
              />
            </Card>

            {/* Chat */}
            <Card title={t('settings:shortcuts.chat')}>
              <CardItem
                title={t('settings:shortcuts.sendMessage')}
                description={t('settings:shortcuts.sendMessageDesc')}
                actions={
                  <KbdGroup>
                    <Kbd>Enter</Kbd>
                  </KbdGroup>
                }
              />
              <CardItem
                title={t('settings:shortcuts.newLine')}
                description={t('settings:shortcuts.newLineDesc')}
                actions={
                  <KbdGroup>
                    <Kbd>Shift</Kbd>
                    <Kbd>Enter</Kbd>
                  </KbdGroup>
                }
              />
            </Card>

            {/* Navigation */}
            <Card title={t('settings:shortcuts.navigation')}>
              <CardItem
                title={t('settings:shortcuts.search')}
                description={t('settings:shortcuts.searchDesc')}
                actions={<ShortcutLabel action={ShortcutAction.SEARCH} />}
              />
              <CardItem
                title={t('settings:shortcuts.goToSettings')}
                description={t('settings:shortcuts.goToSettingsDesc')}
                actions={<ShortcutLabel action={ShortcutAction.GO_TO_SETTINGS} />}
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
