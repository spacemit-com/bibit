import type { ReactNode } from 'react'
import HeaderPage from './HeaderPage'
import SettingsMenu from './SettingsMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function SettingsLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation()

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden">
      <HeaderPage>
        <span className="font-studio text-base font-medium">
          {t('common:settings')}
        </span>
      </HeaderPage>
      <div className="flex min-h-0 flex-1">
        <SettingsMenu />
        <div
          data-settings-content
          className="min-w-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="w-full md:w-4/5 xl:w-4/6 mx-auto">{children}</div>
        </div>
      </div>
    </div>
  )
}
