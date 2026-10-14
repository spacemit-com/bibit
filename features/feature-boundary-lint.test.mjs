import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const lint = (fixture) =>
  spawnSync(
    process.execPath,
    [
      '../node_modules/eslint/bin/eslint.js',
      fixture,
      '--config',
      'eslint.config.js',
      '--no-ignore',
      '--format',
      'json',
    ],
    { cwd: new URL('.', import.meta.url), encoding: 'utf8' }
  )

test('Feature boundary config accepts SDK imports and rejects host/network access', () => {
  const valid = lint('lint-fixtures/valid.ts')
  assert.equal(valid.status, 0, valid.stderr || valid.stdout)

  const invalid = lint('lint-fixtures/invalid.ts')
  assert.equal(invalid.status, 1, invalid.stderr || invalid.stdout)
  const messages = JSON.parse(invalid.stdout)[0].messages
  assert.ok(messages.filter(({ ruleId }) => ruleId === 'no-restricted-imports').length >= 8)
  assert.equal(
    messages.filter(({ message }) => message.includes('Feature code cannot import host internals')).length,
    3
  )
  assert.ok(messages.filter(({ ruleId }) => ruleId === 'no-restricted-globals').length >= 3)
  assert.ok(messages.some(({ ruleId }) => ruleId === 'no-restricted-syntax'))
})
