import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let exitCode = 0

try {
  const workspaceUrl = pathToFileURL(resolve('package.json'))
  const require = createRequire(workspaceUrl)
  const viteUrl = pathToFileURL(require.resolve('vite'))
  const { build } = await import(viteUrl.href)

  await build()
} catch (error) {
  console.error(error)
  exitCode = 1
}

if (process.arch === 'riscv64') {
  process.exit(exitCode)
}

process.exitCode = exitCode
