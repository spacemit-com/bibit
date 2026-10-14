import { useEffect, useState, useMemo, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  IconSearch,
  IconMessage,
  IconHistory,
  IconCirclePlus,
} from '@tabler/icons-react'
import { useThreads } from '@/hooks/useThreads'
import { useSessionSearch, type SessionSearchHit } from '@/hooks/useSessionSearch'
import { localStorageKey } from '@/constants/localStorage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'

const MAX_RECENT_SEARCHES = 5

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [recentVersion, setRecentVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const threads = useThreads((state) => state.threads)
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)
  // 标题命中是本地即时结果，正文命中来自 Runtime；两者在同一个列表里分组展示。
  const contentSearch = useSessionSearch(searchQuery, open)

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setSelectedIndex(0)
      setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
    }
  }, [open])

  // Load recent searches from localStorage
  const recentSearches = useMemo(() => {
    if (!open) return []

    const stored = localStorage.getItem(localStorageKey.recentSearches)
    if (!stored) return []

    try {
      const threadIds = JSON.parse(stored) as string[]
      return threadIds
        .map((id) => threads[id])
        .filter((thread): thread is Thread => thread !== undefined)
        .slice(0, MAX_RECENT_SEARCHES)
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, threads, recentVersion])

  const handleClearRecent = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    localStorage.removeItem(localStorageKey.recentSearches)
    setRecentVersion((v) => v + 1)
  }

  const handleClose = () => {
    setSearchQuery('')
    onOpenChange(false)
  }

  const rememberRecentSearch = (threadId: string) => {
    // Save to recent searches
    const stored = localStorage.getItem(localStorageKey.recentSearches)
    let threadIds: string[] = []

    if (stored) {
      try {
        threadIds = JSON.parse(stored) as string[]
      } catch {
        threadIds = []
      }
    }

    // Remove if already exists and add to front
    threadIds = threadIds.filter((id) => id !== threadId)
    threadIds.unshift(threadId)

    // Keep only MAX_RECENT_SEARCHES
    threadIds = threadIds.slice(0, MAX_RECENT_SEARCHES)

    localStorage.setItem(
      localStorageKey.recentSearches,
      JSON.stringify(threadIds)
    )
  }

  const handleSelectThread = (threadId: string) => {
    rememberRecentSearch(threadId)
    handleClose()
    navigate({ to: route.threadsDetail, params: { threadId } })
  }

  // 正文命中要落到那条消息上：`endSeq` 是这条消息覆盖到的最后一条分片，对话视图
  // 据此读一份以它结尾的历史窗口并滚动到它。
  const handleSelectHit = (hit: SessionSearchHit) => {
    rememberRecentSearch(hit.sessionId)
    handleClose()
    navigate({
      to: route.threadsDetail,
      params: { threadId: hit.sessionId },
      search: { seq: hit.endSeq },
    })
  }

  // Filter and group threads based on search query
  const searchResults = useMemo(() => {
    if (!searchQuery) return { results: [] as Thread[] }
    return { results: getFilteredThreads(searchQuery) }
  }, [searchQuery, getFilteredThreads])

  // Calculate all selectable items for keyboard navigation
  const allItems = useMemo(() => {
    const items: Array<{ type: 'new' | 'recent' | 'result' | 'hit'; id: string }> = []

    if (!searchQuery) {
      // Start new chat option
      items.push({ type: 'new', id: 'new-chat' })
      // Recent searches
      recentSearches.forEach((thread) => {
        items.push({ type: 'recent', id: thread.id })
      })
    } else {
      searchResults.results.forEach((thread) => {
        items.push({ type: 'result', id: thread.id })
      })
      contentSearch.hits.forEach((hit) => {
        items.push({ type: 'hit', id: `${hit.sessionId}:${hit.seq}` })
      })
    }

    return items
  }, [searchQuery, recentSearches, searchResults, contentSearch.hits])

  // Reset selected index when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [allItems.length])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.querySelector(
        `[data-index="${selectedIndex}"]`
      )
      selectedElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, allItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selectedItem = allItems[selectedIndex]
      if (selectedItem) {
        if (selectedItem.type === 'new') {
          handleStartNewChat()
        } else if (selectedItem.type === 'hit') {
          const hit = contentSearch.hits.find(
            (item) => `${item.sessionId}:${item.seq}` === selectedItem.id
          )
          if (hit) handleSelectHit(hit)
        } else {
          handleSelectThread(selectedItem.id)
        }
      }
    }
  }

  const handleStartNewChat = () => {
    handleClose()
    navigate({ to: '/' })
  }

  const showStartNewChat = !searchQuery
  const hasResults =
    searchResults.results.length > 0 || contentSearch.hits.length > 0
  const titleResultCount = searchResults.results.length

  /** 命中片段里把匹配到的字串挑出来：Runtime 给的是片段内偏移。 */
  const renderSnippet = (hit: SessionSearchHit) => {
    const start = Math.max(0, hit.matchStart)
    const end = Math.min(hit.snippet.length, start + Math.max(1, hit.matchLength))
    return (
      <>
        {hit.snippet.slice(0, start)}
        <mark className="bg-transparent font-medium text-foreground">
          {hit.snippet.slice(start, end)}
        </mark>
        {hit.snippet.slice(end)}
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl p-0 gap-0 overflow-hidden"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <VisuallyHidden>
          <DialogTitle>{t('common:search')}</DialogTitle>
        </VisuallyHidden>

        {/* Search Input */}
        <div className="flex items-center border-b  px-3">
          <IconSearch className="size-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('common:searchThreads')}
            className="flex-1 h-12 px-3 bg-transparent placeholder:text-muted-foreground focus:outline-none"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto px-1 py-2">
          {/* Empty state when searching */}
          {searchQuery && !hasResults && (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <IconSearch className="size-6 text-muted-foreground mb-2" />
              <h3 className="text-base font-medium mb-1">
                {t('common:noResultsFound')}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground w-1/2 mx-auto">
                {t('common:noResultsFoundDesc')}
              </p>
            </div>
          )}

          {/* Start new chat - shown when no search query */}
          {showStartNewChat && (
            <div className="p-1">
              <button
                data-index={0}
                onClick={handleStartNewChat}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-secondary/60 transition-colors cursor-pointer',
                  selectedIndex === 0 && 'bg-secondary/50'
                )}
              >
                <IconCirclePlus className="size-4 text-muted-foreground" />
                <span className="text-sm">{t('common:newChat')}</span>
              </button>
            </div>
          )}

          {/* Recent searches - shown when search is empty */}
          {!searchQuery && recentSearches.length > 0 && (
            <div className="p-1">
              <div className="px-3 pt-1.5 flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('common:recents')}
                </span>
                <button
                  onClick={handleClearRecent}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  {t('common:clearRecent')}
                </button>
              </div>
              {recentSearches.map((thread, index) => {
                const itemIndex = 1 + index // +1 for new chat option
                return (
                  <button
                    key={thread.id}
                    data-index={itemIndex}
                    onClick={() => handleSelectThread(thread.id)}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-secondary/60 transition-colors cursor-pointer',
                      selectedIndex === itemIndex && 'bg-secondary/50'
                    )}
                  >
                    <IconHistory className="size-4 text-muted-foreground shrink-0" />
                    <span className="text-sm truncate">{thread.title}</span>
                  </button>
                )
              })}
            </div>
          )}

          {searchQuery && searchResults.results.length > 0 && (
            <div className="p-1">
              <div className="px-3 pt-1.5 mb-1 text-xs font-medium text-muted-foreground">
                {t('common:searchGroupTitles')}
              </div>
              {searchResults.results.map((thread, index) => {
                const itemIndex = index
                return (
                  <button
                    key={thread.id}
                    data-index={itemIndex}
                    onClick={() => handleSelectThread(thread.id)}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-secondary/60 transition-colors cursor-pointer',
                      selectedIndex === itemIndex && 'bg-secondary/50'
                    )}
                  >
                    <IconMessage className="size-4 text-muted-foreground shrink-0" />
                    <span className="text-sm truncate">{thread.title}</span>
                  </button>
                )
              })}
            </div>
          )}

          {searchQuery && contentSearch.loading && (
            <div className="px-4 py-2 text-xs text-muted-foreground" role="status">
              {t('common:searchingContent')}
            </div>
          )}

          {searchQuery && contentSearch.hits.length > 0 && (
            <div className="p-1">
              <div className="px-3 pt-1.5 mb-1 text-xs font-medium text-muted-foreground">
                {t('common:searchGroupMessages')}
              </div>
              {contentSearch.hits.map((hit, index) => {
                const itemIndex = titleResultCount + index
                return (
                  <button
                    key={`${hit.sessionId}:${hit.seq}`}
                    data-testid="search-content-hit"
                    data-index={itemIndex}
                    onClick={() => handleSelectHit(hit)}
                    className={cn(
                      'w-full flex flex-col gap-0.5 px-3 py-2 rounded-md text-left hover:bg-secondary/60 transition-colors cursor-pointer',
                      selectedIndex === itemIndex && 'bg-secondary/50'
                    )}
                  >
                    <span className="flex items-center gap-2 w-full">
                      <IconSearch className="size-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate flex-1">{hit.title}</span>
                      <span className="text-[10px] shrink-0 text-muted-foreground">
                        {hit.role === 'user'
                          ? t('common:searchRoleUser')
                          : t('common:searchRoleAssistant')}
                      </span>
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground pl-6 truncate">
                      {renderSnippet(hit)}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer with keyboard hints */}
        <div className="flex items-center justify-between border-t  px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-secondary/10 rounded text-[10px]">
                ↑↓
              </kbd>
              {t('common:toNavigate')}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-secondary/10 rounded text-[10px]">
                ↵
              </kbd>
              {t('common:toSelect')}
            </span>
          </div>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-secondary/10 rounded text-[10px]">
              esc
            </kbd>
            {t('common:toClose')}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
