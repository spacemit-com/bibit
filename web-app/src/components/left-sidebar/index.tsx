import { NavChats } from './NavChats'
import { NavMain } from './NavMain'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import { useLayoutEffect } from 'react'
import { traceStartup } from '@/services/app/startup-trace'

export { NavigationDialogs } from './NavMain'

// 归因用：只记第一次挂载的 layout effect。
let leftSidebarMountedMarked = false

export function LeftSidebar() {
  useLayoutEffect(() => {
    if (!leftSidebarMountedMarked) {
      leftSidebarMountedMarked = true
      traceStartup('lb_mounted')
    }
  }, [])
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  // Right-align the header when the Linux DE places window controls on the left;
  // "BiBit" moves into the right cluster when there is no left control.
  const controlsOnLeft = leftButtons > 0
  const reserveLeft = controlsOnLeft
  return (
    <div className='relative z-50'>
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader className="flex px-1">
          <div className={cn("flex items-center w-full justify-between", reserveLeft && "justify-end")}>
            {!reserveLeft && <span className="ml-2 text-base font-medium font-studio">BiBit</span>}
            <div className="flex items-center">
              {controlsOnLeft && (
                <span className="mr-2 text-base font-medium font-studio">BiBit</span>
              )}
              <SidebarTrigger className="text-muted-foreground rounded-full hover:bg-sidebar-foreground/8! -mt-0.5 relative z-50 ml-0.5" />
            </div>
          </div>
          <NavMain />
        </SidebarHeader>
        <SidebarContent className="mask-b-from-95% mask-t-from-98%">
          <NavChats />
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    </div>
  )
}
