import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const required = (environment, name) => {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const httpsUrl = (environment, name) => {
  const value = required(environment, name)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials`)
  }
  return value
}

const updaterPublicKey = (environment) => {
  const value = required(environment, 'BIBIT_UPDATER_PUBLIC_KEY')
  const decodedValue = Buffer.from(value, 'base64')
  const lines = decodedValue.toString('utf8').trim().split('\n')
  const key = lines.length === 2 ? Buffer.from(lines[1], 'base64') : Buffer.alloc(0)
  if (
    decodedValue.toString('base64') !== value ||
    lines.length !== 2 ||
    !lines[0].startsWith('untrusted comment: minisign public key:') ||
    key.length !== 42 ||
    key.toString('base64') !== lines[1] ||
    key[0] !== 0x45 ||
    ![0x44, 0x64].includes(key[1])
  ) {
    throw new Error('BIBIT_UPDATER_PUBLIC_KEY must be a base64 minisign public key')
  }
  return value
}

export function validateReleaseEnvironment(environment) {
  const buildVersion = required(environment, 'BIBIT_BUILD_VERSION')
  if (
    environment.BIBIT_BUILD_VERSION !== buildVersion ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(buildVersion) ||
    /^(development|dev|unknown)$/i.test(buildVersion)
  ) {
    throw new Error('BIBIT_BUILD_VERSION must be a non-placeholder release identifier')
  }

  const updaterEndpoint = httpsUrl(environment, 'BIBIT_UPDATER_ENDPOINT')
  for (const token of ['{{target}}', '{{arch}}', '{{current_version}}']) {
    if (!updaterEndpoint.includes(token)) {
      throw new Error(`BIBIT_UPDATER_ENDPOINT must contain ${token}`)
    }
  }

  required(environment, 'TAURI_SIGNING_PRIVATE_KEY')
  if (environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    throw new Error(
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required; use an empty value for an unencrypted key'
    )
  }
  httpsUrl(environment, 'VITE_BIBIT_HELP_URL')
  httpsUrl(environment, 'VITE_BIBIT_FEEDBACK_URL')

  return {
    buildVersion,
    updaterEndpoint,
    updaterPublicKey: updaterPublicKey(environment),
  }
}

export function releaseConfigFromEnv(environment) {
  const { buildVersion, updaterEndpoint, updaterPublicKey } =
    validateReleaseEnvironment(environment)
  return {
    version: buildVersion,
    plugins: {
      updater: {
        endpoints: [updaterEndpoint],
        pubkey: updaterPublicKey,
      },
    },
    bundle: { createUpdaterArtifacts: true },
  }
}

export function releaseBuildArgs(args) {
  if (args.length === 0) return []
  if (
    args.length === 2 &&
    args[0] === '--target' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args[1])
  ) {
    return args
  }
  throw new Error('release build only accepts --target <triple>')
}

export function releaseChildEnvironment(environment, withSigningKey = false) {
  const childEnvironment = {
    ...environment,
    IS_CLEAN: 'true',
    IS_TAURI: 'true',
    IS_DEV: 'false',
    AUTO_UPDATER_DISABLED: 'false',
    TAURI_ENV_PLATFORM: 'linux',
  }
  if (!withSigningKey) {
    delete childEnvironment.TAURI_SIGNING_PRIVATE_KEY
    delete childEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  }
  return childEnvironment
}

function run(command, withSigningKey = false) {
  const result = spawnSync('corepack', ['yarn', ...command], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: releaseChildEnvironment(process.env, withSigningKey),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error(
      `corepack yarn ${command.join(' ')} failed with exit code ${result.status ?? 1}`
    )
    error.exitCode = result.status ?? 1
    throw error
  }
}

function main() {
  const config = releaseConfigFromEnv(process.env)
  const buildArgs = releaseBuildArgs(process.argv.slice(2))
  const directory = mkdtempSync(path.join(tmpdir(), 'bibit-release-'))
  const overlay = path.join(directory, 'tauri.release.conf.json')
  writeFileSync(overlay, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    for (const command of [
      ['feature:registry:check'],
      ['build:tauri:plugin:api'],
      ['build:extensions'],
      ['build:icon'],
      ['copy:assets:tauri'],
      ['tauri', 'build', '--config', overlay, ...buildArgs],
    ]) {
      run(command, command[0] === 'tauri')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
  }
}
