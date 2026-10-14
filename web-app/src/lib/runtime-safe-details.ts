import i18n from '@/i18n/setup'

// 审批与事件详情共用脱敏规则。
export const safeDetails = (value: unknown): string => JSON.stringify(value, (key, item) => /^(access_token|refresh_token|token|secret|password|authorization|api.?key)$/i.test(key) ? i18n.t('trace:redact.hidden') : typeof item === 'string' ? item.replace(/Bearer\s+[^\s"']+/gi, i18n.t('trace:redact.bearer')) : item, 2) ?? ''
