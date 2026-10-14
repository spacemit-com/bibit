import {
  Bot,
  LucideIcon,
  MessageCircle,
  Search,
  Settings,
} from 'lucide-react'
import { route } from '@/constants/routes'

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { Link, useNavigate } from '@tanstack/react-router'
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { once } from '@tauri-apps/api/event'
import type { SearchIconHandle } from '@/components/animated-icon/search'
import type { MessageCircleIconHandle } from '@/components/animated-icon/message-circle'
import type { SettingsIconHandle } from '@/components/animated-icon/settings'
import type { BotIconHandle } from '@/components/animated-icon/bot'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { desktopMainFeatureRegistry } from '@/features/host/registry'
import {
  buildFeatureNavMainItems,
  mergeFeatureNavigation,
} from '@/features/navigation'
import type { FeaturePageNavigationGroup } from '@bibit/feature-contracts'

type AnimatedIconHandle =
  | SearchIconHandle
  | MessageCircleIconHandle
  | SettingsIconHandle
  | BotIconHandle

type AnimatedIconComponent = React.ComponentType<
  { className?: string; size?: number } & React.RefAttributes<AnimatedIconHandle>
>

// 这些图标只为 hover 动画引入 motion（约 120KB / 259 个模块）。改成动态导入后
// 首屏 chunk 不再包含 motion，首帧由同形 lucide 图标顶上，动画在 chunk 到手后接管。
const SearchIcon: AnimatedIconComponent = lazy(() =>
  import('@/components/animated-icon/search').then((m) => ({
    default: m.SearchIcon,
  }))
)
const MessageCircleIcon: AnimatedIconComponent = lazy(() =>
  import('@/components/animated-icon/message-circle').then((m) => ({
    default: m.MessageCircleIcon,
  }))
)
const SettingsIcon: AnimatedIconComponent = lazy(() =>
  import('@/components/animated-icon/settings').then((m) => ({
    default: m.SettingsIcon,
  }))
)
const BotIcon: AnimatedIconComponent = lazy(() =>
  import('@/components/animated-icon/bot').then((m) => ({ default: m.BotIcon }))
)

type NavMainItem = {
  id?: string
  title: string
  literalLabel?: string
  url?: string
  icon?: LucideIcon | React.ComponentType<{ className?: string }>
  animatedIcon?: AnimatedIconComponent
  fallbackIcon?: LucideIcon
  isActive?: boolean
  onClick?: () => void
}

const featureNavigation = mergeFeatureNavigation(
  desktopMainFeatureRegistry.pages.map(({ entry, contribution, finalPath, key }) => ({
    id: key,
    group: contribution.navigation?.group as
      | FeaturePageNavigationGroup
      | undefined,
    order: contribution.navigation?.order,
    title: entry.manifest.display.fallbackTitle,
    titleKey: entry.manifest.display.titleKey,
    path: finalPath,
    iconKey: entry.manifest.display.iconKey,
  }))
)

const getNavMainItems = (
  onSearch: () => void,
  onNewChat: () => void,
  onJanClaw: () => void
): NavMainItem[] => [
  {
    title: 'common:newChat',
    animatedIcon: MessageCircleIcon,
    fallbackIcon: MessageCircle,
    onClick: onNewChat,
  },
  {
    title: 'common:newAgentChat',
    animatedIcon: BotIcon,
    fallbackIcon: Bot,
    onClick: onJanClaw,
  },
  {
    title: 'common:search',
    animatedIcon: SearchIcon,
    fallbackIcon: Search,
    onClick: onSearch,
  },
  {
    title: 'common:settings',
    url: route.settings.general,
    animatedIcon: SettingsIcon,
    fallbackIcon: Settings,
  },
]

function NavMainItemWithAnimatedIcon({
  item,
  label,
  armed,
}: {
  item: NavMainItem
  label: string
  armed: boolean
}) {
  const iconRef = useRef<AnimatedIconHandle>(null)
  const AnimatedIcon = item.animatedIcon!
  const FallbackIcon = item.fallbackIcon!

  const content = (
    <>
      <Suspense
        fallback={<FallbackIcon className="text-foreground/70" size={16} />}
      >
        {armed ? (
          <AnimatedIcon ref={iconRef} className="text-foreground/70" size={16} />
        ) : (
          <FallbackIcon className="text-foreground/70" size={16} />
        )}
      </Suspense>
      <span>{label}</span>
    </>
  )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild={!!item.url}
        isActive={item.isActive}
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
        onClick={item.onClick}
      >
        {item.url ? <Link to={item.url}>{content}</Link> : content}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function NavigationDialogs() {
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()

  return (
    <>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  )
}

export function NavMain() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { setOpen: setSearchOpen } = useSearchDialog()
  // 图标动画纯装饰：等首屏就绪（ExtensionProvider 发 app-ready）再放行那段 chunk。
  // 否则 motion（约 120KB / 259 个模块）会跟在首屏 chunk 里一起求值。
  const [iconsArmed, setIconsArmed] = useState(false)
  useEffect(() => {
    let off: (() => void) | undefined
    void once('app-ready', () => setIconsArmed(true))
      .then((unlisten) => {
        off = unlisten
      })
      // 没有事件总线（vite dev host）时按旧行为立即加载。
      .catch(() => setIconsArmed(true))
    return () => off?.()
  }, [])

  const navMainItems = getNavMainItems(
    () => setSearchOpen(true),
    () => {
      useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
      navigate({ to: route.home })
    },
    () => {
      useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
      navigate({ to: route.home })
    }
  ).filter(
    (item) => item.title !== 'common:newAgentChat'
  )

  const translatedFeatureNavigation = buildFeatureNavMainItems(
    featureNavigation,
    t
  )
  navMainItems.splice(
    Math.max(0, navMainItems.length - 1),
    0,
    ...translatedFeatureNavigation
  )

  return (
    <>
      <SidebarMenu>
        {navMainItems.map((item) => {
          if (item.animatedIcon) {
            return (
              <NavMainItemWithAnimatedIcon
                key={item.id ?? item.title}
                item={item}
                label={item.literalLabel ?? t(item.title)}
                armed={iconsArmed}
              />
            )
          }

          const Icon = item.icon
          return (
            <SidebarMenuItem key={item.id ?? item.title}>
              <SidebarMenuButton
                asChild={!!item.url}
                isActive={item.isActive}
                onClick={item.onClick}
              >
                {item.url ? (
                  <Link to={item.url}>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{item.literalLabel ?? t(item.title)}</span>
                  </Link>
                ) : (
                  <>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{item.literalLabel ?? t(item.title)}</span>
                  </>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </>
  )
}
