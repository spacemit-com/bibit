/** 只识别光标所在的独立 /词或 @词，排除网址、路径、邮箱和选中的正文。 */
export function slashCompletion(text: string, start: number, end = start) {
  if (start !== end) return null
  const before = text.slice(0, start)
  const match = before.match(/(?:^|\s)([/@])([\p{L}\p{N}_-]*)$/u)
  if (!match) return null
  const tail = text.slice(start).match(/^\S*/)?.[0] ?? ''
  if (!/^[\p{L}\p{N}_-]*$/u.test(tail)) return null
  return {
    start: start - match[2].length - 1,
    end: start + tail.length,
    query: match[2],
    trigger: match[1] as '/' | '@',
  }
}
