import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { buildRuntimePrompt, normalizeKnowledgeChunks, prepareKnowledgeMessage, retrieveKnowledge } from '../knowledge-retrieval'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const chunk = { id: 'c', content: '内容', document_id: 'd', document_keyword: '手册.md', similarity: 0.9 }
const success = (chunks: unknown[]) => ({ status: 'succeeded', data: { code: 0, data: { chunks } } })

beforeEach(() => vi.resetAllMocks())
describe('knowledge retrieval boundaries', () => {
  it.each([
    { status: 'failed', error: 'HTTP 401' },
    { status: 'failed', error: 'HTTP 500' },
    { status: 'succeeded', data: { code: 102, message: 'denied', data: { chunks: [] } } },
    { status: 'succeeded', data: {} },
    success([{ ...chunk, content: null }]),
  ])('does not disguise errors as empty results: %j', async (response) => {
    vi.mocked(invoke).mockResolvedValue(response)
    expect((await retrieveKnowledge('问题')).status).toBe('failed')
  })
  it('accepts a valid empty result', async () => {
    vi.mocked(invoke).mockResolvedValue(success([]))
    expect((await retrieveKnowledge('问题')).status).toBe('empty')
  })
  it('deduplicates valid chunks', () => {
    expect(normalizeKnowledgeChunks({ data: { chunks: [chunk, { ...chunk, id: 'other' }] } })).toHaveLength(1)
  })
  it('知识库关闭时不发起检索', async () => {
    expect(await prepareKnowledgeMessage('问题', false)).toEqual({ question: '问题', prompt: '问题' })
    expect(invoke).not.toHaveBeenCalled()
  })
  it('throws on retrieval failure', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'failed', error: 'HTTP 500' })
    await expect(prepareKnowledgeMessage('问题', true)).rejects.toThrow('HTTP 500')
  })
  it('budgets Unicode text including source headers and keeps the injected chunks', async () => {
    vi.mocked(invoke).mockResolvedValue(success(Array.from({ length: 8 }, (_, i) => ({ ...chunk, id: String(i), document_id: String(i), content: '😀'.repeat(4000), document_keyword: '名'.repeat(300) }))))
    const result = await prepareKnowledgeMessage(`${'问'.repeat(1000)}`, true)
    expect(Array.from(result.prompt).length).toBeLessThanOrEqual(16000)
    expect(result.context?.chunks.length).toBeGreaterThan(0)
    expect(result.prompt).toBe(buildRuntimePrompt(result.question, result.context))
    for (const c of result.context!.chunks) expect(result.prompt).toContain(c.content)
    expect(result.prompt).not.toContain('\uFFFD')
  })
  it('rejects a question with no room for any retrieved evidence', async () => {
    vi.mocked(invoke).mockResolvedValue(success([chunk]))
    await expect(prepareKnowledgeMessage('问'.repeat(16000), true)).rejects.toThrow('16000')
  })
  it.each(['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', 'https://user:secret@example.com/a', '/relative', 'invalid'])('drops unsafe reference URLs: %s', (url) => {
    expect(normalizeKnowledgeChunks({ data: { chunks: [{ ...chunk, url }] } })[0].url).toBeUndefined()
  })
  it.each(['https://example.com/manual', 'http://example.com/manual'])('retains ordinary web reference URLs: %s', (url) => {
    expect(normalizeKnowledgeChunks({ data: { chunks: [{ ...chunk, url }] } })[0].url).toBe(url)
  })
  it('rejects an oversized original question without truncation', async () => {
    await expect(prepareKnowledgeMessage('问'.repeat(16001), true)).rejects.toThrow('16000')
    expect(invoke).not.toHaveBeenCalled()
  })
})

it('检索到的资料按原问题拼进提示且不改写正文', async () => {
  vi.mocked(invoke).mockResolvedValue(success([chunk]))
  const result = await prepareKnowledgeMessage('请解释 @someone 的方案', true)
  expect(result.question).toBe('请解释 @someone 的方案')
  expect(result.context?.status).toBe('succeeded')
  expect(invoke).toHaveBeenCalledWith('knowledge_retrieve', { request: { question: result.question, page: 1, pageSize: 10 } })
})
it('无匹配时阻止自动发送无依据回答', async () => {
  vi.mocked(invoke).mockResolvedValue(success([]))
  await expect(prepareKnowledgeMessage('问题', true)).rejects.toThrow('No related material found in the knowledge base')
})
