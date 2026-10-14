import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  releaseBuildArgs,
  releaseChildEnvironment,
  releaseConfigFromEnv,
  validateReleaseEnvironment,
} from './build-bibit-release.mjs'

const publicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJFNDEzMEVCMUEzNUFENDQKUldSRXJUVWE2ekJCTGc1Mm1BVXgrWmtES3huUlBFR0lCdG5qbWFvMzgyNDhGN3VTTko5Q1NtTW0K'

const validEnvironment = {
  BIBIT_BUILD_VERSION: '0.1.3+2431d70',
  VITE_BIBIT_HELP_URL: 'https://docs.example.com/bibit',
  VITE_BIBIT_FEEDBACK_URL: 'https://forum.example.com/bibit',
  BIBIT_UPDATER_ENDPOINT:
    'https://updates.example.com/{{target}}/{{arch}}/{{current_version}}',
  BIBIT_UPDATER_PUBLIC_KEY: publicKey,
  TAURI_SIGNING_PRIVATE_KEY: '/run/secrets/bibit-updater.key',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
}

test('release input validation accepts a complete signed HTTPS channel', () => {
  assert.deepEqual(validateReleaseEnvironment(validEnvironment), {
    buildVersion: validEnvironment.BIBIT_BUILD_VERSION,
    updaterEndpoint: validEnvironment.BIBIT_UPDATER_ENDPOINT,
    updaterPublicKey: publicKey,
  })
})

test('release input validation rejects missing, placeholder and insecure values', () => {
  for (const [name, value] of [
    ['BIBIT_BUILD_VERSION', 'development'],
    ['BIBIT_BUILD_VERSION', ' 0.1.3+2431d70'],
    ['VITE_BIBIT_HELP_URL', 'http://docs.example.com/bibit'],
    ['VITE_BIBIT_FEEDBACK_URL', ''],
    [
      'BIBIT_UPDATER_ENDPOINT',
      'https://updates.example.com/{{target}}/{{current_version}}',
    ],
    ['BIBIT_UPDATER_PUBLIC_KEY', 'not-a-minisign-key'],
    [
      'BIBIT_UPDATER_PUBLIC_KEY',
      Buffer.from(
        `untrusted comment: minisign public key: test\n${Buffer.alloc(42, 1).toString('base64')}\n`
      ).toString('base64'),
    ],
    ['TAURI_SIGNING_PRIVATE_KEY', ''],
    ['TAURI_SIGNING_PRIVATE_KEY_PASSWORD', undefined],
  ]) {
    assert.throws(
      () => validateReleaseEnvironment({ ...validEnvironment, [name]: value }),
      new RegExp(name)
    )
  }
})

test('release preparation cannot read updater signing credentials', () => {
  const unsignedEnvironment = releaseChildEnvironment(validEnvironment)
  assert.equal('TAURI_SIGNING_PRIVATE_KEY' in unsignedEnvironment, false)
  assert.equal('TAURI_SIGNING_PRIVATE_KEY_PASSWORD' in unsignedEnvironment, false)

  const signingEnvironment = releaseChildEnvironment(validEnvironment, true)
  assert.equal(
    signingEnvironment.TAURI_SIGNING_PRIVATE_KEY,
    validEnvironment.TAURI_SIGNING_PRIVATE_KEY
  )
  assert.equal(signingEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, '')
})

test('release config contains public updater material and no private key', () => {
  const config = releaseConfigFromEnv(validEnvironment)

  assert.deepEqual(config, {
    version: validEnvironment.BIBIT_BUILD_VERSION,
    plugins: {
      updater: {
        endpoints: [validEnvironment.BIBIT_UPDATER_ENDPOINT],
        pubkey: publicKey,
      },
    },
    bundle: { createUpdaterArtifacts: true },
  })
  assert.doesNotMatch(JSON.stringify(config), /bibit-updater\.key/)
})

test('release build only forwards an optional target triple', () => {
  assert.deepEqual(releaseBuildArgs([]), [])
  assert.deepEqual(releaseBuildArgs(['--target', 'riscv64gc-unknown-linux-gnu']), [
    '--target',
    'riscv64gc-unknown-linux-gnu',
  ])
  assert.throws(() => releaseBuildArgs(['--features', 'demo-runtime']))
  assert.throws(() => releaseBuildArgs(['--target', '../unsafe']))
})

test('package exposes the fail-closed release build entry', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  )
  assert.equal(
    pkg.scripts['build:release:linux'],
    'node scripts/build-bibit-release.mjs'
  )
})
