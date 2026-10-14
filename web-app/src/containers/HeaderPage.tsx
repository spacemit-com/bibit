import { useLeftPanel } from '@/hooks/useLeftPanel'
import { cn } from '@/lib/utils'
import {
  IconArrowLeft,
  IconLayoutSidebar,
} from '@tabler/icons-react'
import { ReactNode, memo, useLayoutEffect } from 'react'
import { traceStartup } from '@/services/app/startup-trace'
import { Button } from "@/components/ui/button"
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useSettingsNavigation } from '@/hooks/useSettingsNavigation'
import { useTranslation } from '@/i18n'

type HeaderPageProps = {
  children?: ReactNode
  className?: string
}
// 归因用：只记第一次挂载的 layout effect。
let headerPageMountedMarked = false

const HeaderPage = memo(function HeaderPage({
  children,
  className,
}: HeaderPageProps) {
  useLayoutEffect(() => {
    if (!headerPageMountedMarked) {
      headerPageMountedMarked = true
      traceStartup('hp_mounted')
    }
  }, [])
  const { t } = useTranslation()
  const { open, setLeftPanel } = useLeftPanel()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const settingsOrigin = useSettingsNavigation((state) => state.origin)
  const isSettingsRoute =
    pathname === route.settings.index ||
    pathname.startsWith(`${route.settings.index}/`)
  const handleBack = () => {
    void navigate({ href: settingsOrigin ?? route.home })
  }
  // Native window controls are an absolute overlay pinned to the window edge
  // (`WindowControls`, z-[60], size-8 buttons inset 4). The header owns the same
  // strip, so it has to indent past whichever side the DE anchors them to.
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const rightButtons = useTitlebarLayout((s) => s.layout.right.length)
  const ownsTopLeft = isSettingsRoute || !open
  // Collapsed (or in settings, where the sidebar is hidden) the left strip is
  // this header's; otherwise the sidebar handles its own left spacing.
  const leftControlsPad =
    ownsTopLeft && leftButtons > 0
      ? leftButtons * 32 + 24
      : undefined
  // Nothing else yields the right strip — every right-anchored control would sit
  // on top of the header's own trailing content (status / quick chat / CLI).
  const rightControlsPad =
    IS_LINUX && rightButtons > 0
      ? rightButtons * 32 + 24
      : undefined

  return (
    <div
      className={cn(
        'h-15 flex items-center shrink-0',
        'pl-4',
        children === undefined && 'border-none',
        className
      )}
      style={
        leftControlsPad || rightControlsPad
          ? { paddingLeft: leftControlsPad, paddingRight: rightControlsPad }
          : undefined
      }
    >
      <div
        className={cn(
          'flex items-center w-full gap-1',
        )}
      >
        {isSettingsRoute && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full relative z-50"
            onClick={handleBack}
            aria-label={t('common:back')}
            title={t('common:back')}
          >
            <IconArrowLeft className="text-muted-foreground size-4.5" />
          </Button>
        )}
        {!open && !isSettingsRoute && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className='rounded-full relative z-50'
              onClick={() => setLeftPanel(!open)}
              aria-label={t('settings:shortcuts.toggleSidebar')}
            >
              <IconLayoutSidebar
                className="text-muted-foreground relative size-4.5"
              />
            </Button>
          </>
        )}
        <div
          className={cn(
            'flex-1 min-w-0'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
})

export default HeaderPage
