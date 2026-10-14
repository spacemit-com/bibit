import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let exitCode = 0

try {
  const configUrl = pathToFileURL(
    resolve(process.argv[2] ?? 'rolldown.config.mjs')
  )
  const config = (await import(configUrl.href)).default
  const require = createRequire(configUrl)
  const { build } = require('rolldown')

  await build(config)
} catch (error) {
  console.error(error)
  exitCode = 1
}

if (process.arch === 'riscv64') {
  process.exit(exitCode)
}

process.exitCode = exitCode
