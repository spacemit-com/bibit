import { beforeAll, describe, expect, it } from 'vitest'
import i18n from '@/i18n/setup'
import zh from '@/locales/zh-CN/trace.json'
import en from '@/locales/en/trace.json'
import {
  clipText,
  describeGroupSummary,
  describeToolRow,
  formatTraceDuration,
  humanizeToolName,
  parseMcpToolName,
  traceStatusKey,
  type TraceGroupItem,
  type TraceToolInput,
} from '@/lib/trace-presentation'

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options)

const tool = (overrides: Partial<TraceToolInput> = {}): TraceToolInput => ({
  name: 'read_file',
  input: { path: '/tmp/notes.md' },
  status: 'completed',
  ...overrides,
})

beforeAll(() => {
  i18n.changeLanguage('zh-CN')
})

describe('tool row copy', () => {
  it.each([
    ['terminal', { command: 'npm test\n--watch' }, '执行命令 npm test'],
    ['bash', { command: 'ls -la' }, '执行命令 ls -la'],
    ['read_file', { file_path: 'src/app.ts' }, '读取 src/app.ts'],
    ['write_file', { path: 'src/app.ts' }, '修改 src/app.ts'],
    ['str_replace', { path: 'src/app.ts' }, '修改 src/app.ts'],
    ['list_dir', { path: 'src' }, '列出 src'],
    ['grep', { pattern: 'TODO' }, '搜索 TODO'],
    ['web_search', { query: 'RISC-V 工具链' }, '联网搜索 RISC-V 工具链'],
    ['web_fetch', { url: 'https://example.com/docs?q=1' }, '抓取 example.com'],
  ])('renders %s from the request it actually made', (name, input, expected) => {
    const row = describeToolRow(tool({ name, input }), t)
    expect(row.primary).toBe(expected)
    expect(row.secondary).toBe(humanizeToolName(name))
    expect(row.status).toBe('success')
  })

  it('names both sides of an MCP tool', () => {
    expect(parseMcpToolName('mcp__files__read')).toEqual({
      server: 'files',
      tool: 'read',
    })
    expect(parseMcpToolName('files::read')).toEqual({
      server: 'files',
      tool: 'read',
    })
    expect(parseMcpToolName('read_file')).toBeUndefined()
    expect(
      describeToolRow(tool({ name: 'mcp__files__read', input: {} }), t).primary
    ).toBe('调用 files 的 read')
  })

  it('falls back to the tool name plus its first scalars, never to JSON', () => {
    const row = describeToolRow(
      tool({ name: 'make_report', input: { scope: 'daily', days: 7, nested: { a: 1 } } }),
      t
    )
    expect(row.primary).toBe('make report')
    expect(row.secondary).toBe('scope: daily · days: 7')
    expect(`${row.primary}${row.secondary}`).not.toMatch(/[{}"]/)
  })

  it('shows the tool name alone when the request is missing', () => {
    const row = describeToolRow(tool({ input: undefined }), t)
    expect(row.primary).toBe('read file')
    expect(row.secondary).toBeUndefined()
  })

  it('truncates the action in the row and keeps the reason under 80 characters', () => {
    const long = `读取 ${'a'.repeat(200)}`
    expect(clipText(long)).toHaveLength(60)
    const row = describeToolRow(
      tool({
        name: 'terminal',
        input: { command: `echo ${'x'.repeat(200)}` },
        error: `line one\n${'y'.repeat(200)}`,
        status: 'failed',
      }),
      t
    )
    expect(row.primary.length).toBeLessThanOrEqual(60)
    expect(row.secondary).toBe('line one')
    expect(row.failureReason).toBe('line one')
    expect(row.status).toBe('error')
    expect(row.statusLabel).toBe('执行失败')
  })

  it('maps runtimes statuses onto the four trace states', () => {
    expect(traceStatusKey('pending')).toBe('idle')
    expect(traceStatusKey('running')).toBe('running')
    expect(traceStatusKey('completed')).toBe('success')
    expect(traceStatusKey('failed')).toBe('error')
  })

  it('speaks the interface language', () => {
    i18n.changeLanguage('en')
    const row = describeToolRow(tool(), t)
    expect(row.primary).toBe('Read /tmp/notes.md')
    expect(row.statusLabel).toBe('Done')
    i18n.changeLanguage('zh-CN')
  })
})

describe('durations', () => {
  it('formats seconds and minutes per locale', () => {
    expect(formatTraceDuration(12_400, 'zh-CN')).toBe('12 秒')
    expect(formatTraceDuration(12_400, 'en')).toBe('12s')
    expect(formatTraceDuration(65_000, 'zh-CN')).toBe('1 分 05 秒')
    expect(formatTraceDuration(65_000, 'en')).toBe('1m 05s')
  })
})

describe('group summary', () => {
  const reasoning = (streaming: boolean): TraceGroupItem => ({
    kind: 'reasoning',
    streaming,
  })
  const running: TraceGroupItem = {
    kind: 'tool',
    name: 'read_file',
    input: { path: 'src/app.ts' },
    status: 'running',
  }
  const done: TraceGroupItem = { ...running, status: 'completed' }
  const failed: TraceGroupItem = {
    ...running,
    status: 'failed',
    error: 'permission denied',
  }

  it('reports the step that is running right now', () => {
    const summary = describeGroupSummary([reasoning(false), running], t, 'zh-CN')
    expect(summary.text).toBe('正在工作 · 第 2 步 · 读取 src/app.ts')
    expect(summary.status).toBe('running')
    expect(summary.forceOpen).toBe(false)
  })

  it('reports a settled run by steps and duration', () => {
    const summary = describeGroupSummary(
      [done, done, reasoning(false)],
      t,
      'zh-CN',
      42_000
    )
    expect(summary.text).toBe('已完成 3 步 · 用时 42 秒')
    expect(summary.status).toBe('success')
  })

  it('reports failures without claiming the run is working', () => {
    const summary = describeGroupSummary([failed, done], t, 'zh-CN')
    expect(summary.text).toBe('2 步中 1 步失败')
    expect(summary.status).toBe('error')
  })

  it('reports a reasoning-only run', () => {
    expect(describeGroupSummary([reasoning(false)], t, 'zh-CN').text).toBe('已思考')
    expect(
      describeGroupSummary([reasoning(false)], t, 'zh-CN', 12_000).text
    ).toBe('已思考 12 秒')
  })

  it('asks for approval and pins the group open', () => {
    const summary = describeGroupSummary(
      [done, { kind: 'permission', pending: true }],
      t,
      'zh-CN'
    )
    expect(summary.text).toBe('1 个操作等待审批')
    expect(summary.status).toBe('attention')
    expect(summary.forceOpen).toBe(true)
  })

  it('never calls a stopped run working, even with an unfinished tool', () => {
    const stuck: TraceGroupItem = { ...running, status: 'pending' }
    expect(describeGroupSummary([stuck], t, 'zh-CN').status).toBe('running')
    expect(describeGroupSummary([stuck], t, 'zh-CN', undefined, false)).toEqual({
      text: '已完成 1 步',
      status: 'success',
      statusLabel: '已完成',
      forceOpen: false,
    })
  })
})

describe('trace locale resources', () => {
  const keys = (value: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(value).flatMap(([key, child]) =>
      child && typeof child === 'object'
        ? keys(child as Record<string, unknown>, `${prefix}${key}.`)
        : [`${prefix}${key}`]
    )

  it('keeps zh-CN and en in step', () => {
    expect(keys(zh).sort()).toEqual(keys(en).sort())
  })
})
