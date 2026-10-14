import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LINUX_WINDOW_CONTROLS_MARKER =
  'bibit-linux-window-controls-v1'

const javascriptFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return javascriptFiles(path)
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [path] : []
  })

export const verifyLinuxWindowControls = (distDirectory) => {
  const dist = resolve(distDirectory)
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    throw new Error(
      `Linux frontend dist does not exist: ${dist}. Rebuild with: corepack yarn build:web:linux`
    )
  }

  const found = javascriptFiles(dist).some((path) =>
    readFileSync(path, 'utf8').includes(LINUX_WINDOW_CONTROLS_MARKER)
  )
  if (!found) {
    throw new Error(
      `Linux window controls marker ${LINUX_WINDOW_CONTROLS_MARKER} was not found in ${dist}. Rebuild with: corepack yarn build:web:linux`
    )
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  try {
    verifyLinuxWindowControls(process.argv[2] ?? 'web-app/dist')
    process.stdout.write('Linux window controls marker verified\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  }
}
