/**
 * 跨端错误契约：Bibit 直接读 Runtime 维护的 fixture。
 *
 * fixture 由 `bianbu-agent-runtime/tests/fixtures/error-contract/` 拥有，
 * Runtime 侧用同一批文件断言自己产出的错误对象。这里断言的是另一半：
 * Runtime 给的字段一个都不能在投影里丢掉。
 *
 * 两个 checkout 不在一起时（例如在 worktree 里跑）用
 * `BIANBU_RUNTIME_ROOT=<runtime checkout>` 指向 Runtime 仓库。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  projectSessionEvents,
  sessionMessageToUIMessage,
  type SessionEvent,
} from '../runtime-session-projection'

const CANDIDATES = [
  process.env.BIANBU_RUNTIME_ROOT
    ? join(process.env.BIANBU_RUNTIME_ROOT, 'tests/fixtures/error-contract')
    : undefined,
  resolve(process.cwd(), '../../bianbu-agent-runtime/tests/fixtures/error-contract'),
].filter((dir): dir is string => Boolean(dir))

const fixtureDir = CANDIDATES.find(dir => existsSync(dir))

type Fixture = {
  name: string
  description: string
  error: { code: string, message: string, retryable: boolean, details: Record<string, unknown> }
  diagnostic?: { code: string, message: string, retryable: boolean, details: Record<string, unknown> }
  ui_detail_keys?: string[]
}

const event = (
  seq: number,
  type: string,
  data: Record<string, unknown>,
): SessionEvent => ({ seq, type, data, run_id: 'r1', time: seq })

const fixtures: Fixture[] = fixtureDir
  ? readdirSync(fixtureDir).filter(name => name.endsWith('.json')).sort()
    .map(name => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as Fixture)
  : []

/** 只取这一轮 Run 产生的诊断，跳过其它部件。 */
const diagnostics = (events: SessionEvent[]) =>
  sessionMessageToUIMessage(projectSessionEvents(events).messages[0]).parts
    .filter(part => part.type === 'data-runtime-diagnostic')
    .map(part => part.data as Record<string, unknown>)

describe.skipIf(!fixtureDir)('跨端错误契约 fixture', () => {
  it('fixture 目录非空', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  it.each(fixtures.map(fixture => [fixture.name, fixture] as const))(
    '%s：终态失败的结构化字段全部保留',
    (_name, fixture) => {
      const [diagnostic] = diagnostics([event(1, 'run/failed', { error: fixture.error })])
      expect(diagnostic).toMatchObject({
        level: 'warning',
        code: fixture.error.code,
        message: fixture.error.message,
        retryable: fixture.error.retryable,
      })
      if (Object.keys(fixture.error.details).length) {
        expect(diagnostic.details).toEqual(fixture.error.details)
      }
    },
  )

  it.each(fixtures.filter(fixture => fixture.diagnostic).map(
    fixture => [fixture.name, fixture] as const,
  ))('%s：过程中的诊断同样可见', (_name, fixture) => {
    const parts = diagnostics([
      event(1, 'run/event', { kind: 'error', payload: fixture.diagnostic }),
      event(2, 'run/failed', { error: fixture.error }),
    ])
    expect(parts).toContainEqual(expect.objectContaining({
      code: fixture.diagnostic!.code,
      message: fixture.diagnostic!.message,
      retryable: fixture.diagnostic!.retryable,
    }))
    expect(parts).toHaveLength(2)
  })

  it.each(fixtures.map(fixture => [fixture.name, fixture] as const))(
    '%s：界面要展示的字段没有被剪掉',
    (_name, fixture) => {
      const parts = diagnostics([
        ...(fixture.diagnostic
          ? [event(1, 'run/event', { kind: 'error', payload: fixture.diagnostic })]
          : []),
        event(2, 'run/failed', { error: fixture.error }),
      ])
      const present = new Set(parts.flatMap(
        part => Object.keys((part.details ?? {}) as Record<string, unknown>),
      ))
      for (const key of fixture.ui_detail_keys ?? []) {
        expect(present).toContain(key)
      }
    },
  )
})
