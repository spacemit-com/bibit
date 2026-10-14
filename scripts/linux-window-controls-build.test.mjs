import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const verifier = fileURLToPath(
  new URL('./verify-linux-window-controls.mjs', import.meta.url)
)
const rustGuard = fileURLToPath(
  new URL(
    '../src-tauri/build_support/linux_window_controls.rs',
    import.meta.url
  )
)

const createDist = (source) => {
  const root = mkdtempSync(join(tmpdir(), 'bibit-window-controls-'))
  const assets = join(root, 'assets')
  mkdirSync(assets)
  writeFileSync(join(assets, 'index.js'), source)
  return root
}

const runVerifier = (dist) =>
  spawnSync(process.execPath, [verifier, dist], { encoding: 'utf8' })

test('rejects a Linux GUI dist without the window controls marker', (t) => {
  const dist = createDist('console.log("no controls")')
  t.after(() => rmSync(dist, { recursive: true, force: true }))

  const result = runVerifier(dist)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /bibit-linux-window-controls-v1/)
  assert.match(result.stderr, /corepack yarn build:web:linux/)
})

test('accepts a Linux GUI dist containing the window controls marker', (t) => {
  const dist = createDist('const marker="bibit-linux-window-controls-v1"')
  t.after(() => rmSync(dist, { recursive: true, force: true }))

  const result = runVerifier(dist)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Linux window controls marker verified/)
})

test('only verifies Linux release GUI artifacts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bibit-window-controls-guard-'))
  const binary = join(
    root,
    process.platform === 'win32' ? 'guard-tests.exe' : 'guard-tests'
  )
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const compile = spawnSync(
    'rustc',
    ['--edition=2021', '--test', rustGuard, '-o', binary],
    { encoding: 'utf8' }
  )
  assert.equal(compile.status, 0, compile.stderr)

  const result = spawnSync(binary, ['--nocapture'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, /3 passed/)
})
