import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifestUrl = new URL('../LICENSES/THIRD-PARTY.json', import.meta.url)

test('third-party license manifest describes the installed JavaScript and Rust graphs', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))

  assert.equal(manifest.schemaVersion, 1)
  assert.ok(manifest.javascript.some(({ name }) => name === 'react'))
  assert.ok(manifest.rust.some(({ name }) => name === 'tauri'))
  for (const entries of [manifest.javascript, manifest.rust]) {
    assert.ok(entries.length > 0)
    assert.ok(entries.every(({ name, version, license }) => name && version && license))
  }
})
