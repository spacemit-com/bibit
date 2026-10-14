import React, { ReactNode, useEffect, useCallback, useState } from "react"
import { emit, listen } from "@tauri-apps/api/event"
import i18next, { loadTranslations } from "./setup"
import { useGeneralSetting } from "@/hooks/useGeneralSetting"
import { TranslationContext } from "./context"
import { normalizeLanguage } from './supportedLanguages'
import { isPlatformTauri } from '@/lib/platform/utils'

/**
 * 每个窗口（主窗口 / 状态浮窗 / 语音浮窗）是独立 webview，各自持有一份 i18next 与
 * zustand store，`currentLanguage` 不跨窗口同步。主窗口切换语言后必须广播，否则
 * 别的窗口会停在启动时解析出的语言（SpacemiT K3 实测：界面已切中文，语音浮窗仍全英文）。
 */
export const APP_LANGUAGE_CHANGED_EVENT = 'app-language-changed'

// Translation provider component
export const TranslationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Get the current language from general settings
	const { currentLanguage } = useGeneralSetting()
	const [appliedLanguage, setAppliedLanguage] = useState(i18next.language)

	// Load translations once when the component mounts
	useEffect(() => {
		try {
			loadTranslations()
		} catch (error) {
			console.error("Failed to load translations:", error)
		}
	}, [])

	// Update language when currentLanguage changes
	useEffect(() => {
		const syncLanguage = () => {
			i18next.changeLanguage(normalizeLanguage(currentLanguage))
			setAppliedLanguage(i18next.language)
		}
		syncLanguage()
		if (currentLanguage !== 'system') return
		window.addEventListener('languagechange', syncLanguage)
		return () => window.removeEventListener('languagechange', syncLanguage)
	}, [currentLanguage])

	// The native side (tray menu, popup window titles) renders its own text and
	// cannot read the app locale; push the resolved language so it stops showing
	// Chinese to English users.
	useEffect(() => {
		if (!appliedLanguage || !isPlatformTauri()) return
		void emit(APP_LANGUAGE_CHANGED_EVENT, appliedLanguage).catch((err) =>
			console.error('app-language-changed emit failed:', err)
		)
		if (!IS_LINUX) return
		import('@tauri-apps/api/core')
			.then(({ invoke }) => invoke('set_tray_language', { language: appliedLanguage }))
			.catch((err) => console.error('set_tray_language failed:', err))
	}, [appliedLanguage])

	// 接收别的窗口推来的语言；已经是同一个语言就直接跳过，避免来回广播。
	useEffect(() => {
		if (!isPlatformTauri()) return
		let unlisten: (() => void) | undefined
		let disposed = false
		void listen<string>(APP_LANGUAGE_CHANGED_EVENT, ({ payload }) => {
			if (!payload || payload === i18next.language) return
			i18next.changeLanguage(payload)
			setAppliedLanguage(i18next.language)
		})
			.then((fn) => {
				if (disposed) fn()
				else unlisten = fn
			})
			.catch((err) => console.error('app-language-changed listen failed:', err))
		return () => {
			disposed = true
			unlisten?.()
		}
	}, [])

	// Memoize the translation function to prevent unnecessary re-renders
	const translate = useCallback(
		(key: string, options?: Record<string, unknown>) => {
			return i18next.t(key, options)
		},
		[],
	)

	return (
		<TranslationContext.Provider
			value={{
				t: translate,
				i18n: { ...i18next, language: appliedLanguage },
			}}>
			{children}
		</TranslationContext.Provider>
	)
}

export default TranslationProvider
