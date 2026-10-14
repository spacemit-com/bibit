import { formatDate } from '@/utils/formatDate'

/**
 * Render assistant instructions by replacing supported placeholders.
 * Supported placeholders:
 * - {{current_date}}: Inserts today’s date (UTC, long month), e.g., August 16, 2025.
 */
export function renderInstructions(instructions: string): string
export function renderInstructions(
  instructions?: string
): string | undefined
export function renderInstructions(
  instructions?: string
): string | undefined {
  if (!instructions) return instructions

  // 提示词是模型侧内容，不跟界面语言变：固定 en-US，保证同一天的提示词稳定。
  const currentDateStr = formatDate(new Date(), {
    includeTime: false,
    locale: 'en-US',
  })

  // Replace current_date (allow spaces inside braces).
  let rendered = instructions
  rendered = rendered.replace(/\{\{\s*current_date\s*\}\}/gi, currentDateStr)
  return rendered
}
