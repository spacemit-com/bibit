import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useAppTranslation } from '@/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChevronsUpDown } from 'lucide-react'
import {
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from '@/i18n/supportedLanguages'

export default function LanguageSwitcher() {
  const { i18n, t } = useAppTranslation()
  const { setCurrentLanguage, currentLanguage } = useGeneralSetting()

  const changeLanguage = (language: SupportedLanguage) => {
    i18n.changeLanguage(language)
    setCurrentLanguage(language)
  }

  const activeLanguage = normalizeLanguage(currentLanguage)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between">
          {SUPPORTED_LANGUAGES.find(
            (lang: { value: string; label: string }) =>
              lang.value === activeLanguage
          )?.label || t('common:english')}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.value}
            className={cn(
              'cursor-pointer my-0.5',
              activeLanguage === lang.value && 'bg-secondary-foreground/8'
            )}
            onClick={() => changeLanguage(lang.value)}
          >
            {lang.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
