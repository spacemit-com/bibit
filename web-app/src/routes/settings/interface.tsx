import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ThemeSwitcher } from '@/containers/ThemeSwitcher'
import { FontSizeSwitcher } from '@/containers/FontSizeSwitcher'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { Switch } from '@/components/ui/switch'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.interface as any)({
  component: InterfaceSettings,
})

function InterfaceSettings() {
  const { t } = useTranslation()
  const {
    autoGenerateTitle,
    setAutoGenerateTitle,
  } = useInterfaceSettings()

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
            {/* Interface */}
            <Card title={t('settings:interface.title')}>
              <CardItem
                title={t('settings:interface.theme')}
                description={t('settings:interface.themeDesc')}
                actions={<ThemeSwitcher />}
              />
              <CardItem
                title={t('settings:interface.fontSize')}
                description={t('settings:interface.fontSizeDesc')}
                actions={<FontSizeSwitcher />}
              />
              <CardItem
                title={t('settings:interface.autoGenerateTitle')}
                description={t('settings:interface.autoGenerateTitleDesc')}
                actions={
                  <Switch
                    checked={autoGenerateTitle}
                    onCheckedChange={setAutoGenerateTitle}
                  />
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
