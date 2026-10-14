import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { IconLoader2, IconRefresh } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  skillDisplayName,
  skillLocalizedDescription,
  skillMatchedOnlyByDescription,
  filterRuntimeSkills,
  type useRuntimeSkills,
  type RuntimeSkill,
} from '@/hooks/useRuntimeSkills'

type RuntimeSkillPickerProps = {
  selected: RuntimeSkill[]
  onAdd: (skill: RuntimeSkill) => void
  catalog: ReturnType<typeof useRuntimeSkills>
}

/** 技能多选面板：搜索 + 键盘导航；选中结果由父组件以 chips 展示。 */
export function RuntimeSkillPicker({
  selected,
  onAdd,
  catalog,
}: RuntimeSkillPickerProps) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const { skills, loading, error, refresh } = catalog
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const filtered = useMemo(() => filterRuntimeSkills(skills, query), [skills, query])
  const selectedIds = useMemo(
    () => new Set(selected.map((skill) => skill.id)),
    [selected]
  )
  const index = Math.min(activeIndex, Math.max(filtered.length - 1, 0))

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [index, query])

  return (
    <PopoverContent align="start" className="w-80 p-0">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <input
          autoFocus
          value={query}
          aria-label={t('chat:searchSkills')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={true}
          aria-controls={listId}
          aria-activedescendant={filtered[index] ? `${listId}-${index}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIndex(Math.max(0, Math.min(index + 1, filtered.length - 1)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIndex(Math.max(index - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const skill = filtered[index]
              if (skill) onAdd(skill)
            }
          }}
          placeholder={t('chat:searchAllSkills')}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-testid="skill-picker-search"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0"
          aria-label={t('chat:reloadSkills')}
          onClick={refresh}
        >
          <IconRefresh size={14} />
        </Button>
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label={t('chat:availableSkills')} aria-multiselectable={true} className="max-h-64 overflow-y-auto p-1">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <IconLoader2 size={14} className="animate-spin" />
            {t('chat:loadingSkills')}
          </div>
        )}
        {!loading && error && (
          <div className="px-2 py-3 text-sm text-destructive">
            {error}
            <Button variant="ghost" size="sm" className="ml-2 h-6" onClick={refresh}>
              {t('chat:retry')}
            </Button>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            {t('chat:noMatchingAvailableSkills')}
          </div>
        )}
        {!loading &&
          !error &&
          filtered.map((skill, i) => (
            <button
              key={skill.id}
              id={`${listId}-${i}`}
              data-active={i === index}
              type="button"
              role="option"
              aria-selected={selectedIds.has(skill.id)}
              onClick={() => onAdd(skill)}
              onMouseMove={() => setActiveIndex(i)}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left',
                i === index && 'bg-accent'
              )}
              data-testid={`skill-picker-item-${skill.id}`}
            >
              <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                <span className="truncate">{skillDisplayName(skill, i18n.language)}</span>
                {selectedIds.has(skill.id) && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('chat:skillAdded')}
                  </span>
                )}
              </span>
              {/* 只看 description 会漏掉只有 description_zh 的技能，命中理由得照给。 */}
              {skillMatchedOnlyByDescription(skill, query) && (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {skillLocalizedDescription(skill, i18n.language)}
                </span>
              )}
            </button>
          ))}
      </div>
    </PopoverContent>
  )
}
