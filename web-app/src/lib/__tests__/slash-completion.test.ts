import { expect, it } from 'vitest'
import { slashCompletion } from '../slash-completion'

it('补齐光标处的词，并排除普通路径和选区', () => {
  expect(slashCompletion('请 /总结 后续', 5)).toEqual({ start: 2, end: 5, query: '总结', trigger: '/' })
  expect(slashCompletion('请 /summarize 后续', 6)).toEqual({ start: 2, end: 12, query: 'sum', trigger: '/' })
  expect(slashCompletion('第一行\n/', 5)).toEqual({ start: 4, end: 5, query: '', trigger: '/' })
  for (const text of ['https://a/b', '/etc/hosts', './file', '请 /tmp/a.txt', '请 /etc/', '请 /a.b']) {
    expect(slashCompletion(text, text.length)).toBeNull()
  }
  expect(slashCompletion('/etc/hosts', 4)).toBeNull()
  expect(slashCompletion('/test', 1, 5)).toBeNull()
})

it('识别 @ 提及，不误伤邮箱、网址和正文里的 @', () => {
  expect(slashCompletion('@', 1)).toEqual({ start: 0, end: 1, query: '', trigger: '@' })
  expect(slashCompletion('帮我看 @知识', 7)).toEqual({ start: 4, end: 7, query: '知识', trigger: '@' })
  expect(slashCompletion('第一行\n@k', 6)).toEqual({ start: 4, end: 6, query: 'k', trigger: '@' })
  for (const text of ['a@b.com', 'https://a/@b', '名字@企业.com', '@@']) {
    expect(slashCompletion(text, text.length)).toBeNull()
  }
})
