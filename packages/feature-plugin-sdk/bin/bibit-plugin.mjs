#!/usr/bin/env node

import { resolve } from 'node:path'
import {
  buildPluginBundle,
  generatePluginSigningKey,
} from '../src/buildPlugin.js'

const arguments_ = process.argv.slice(2)
const command = arguments_.shift()

const option = (name) => {
  const index = arguments_.indexOf(name)
  if (index < 0 || index === arguments_.length - 1) return undefined
  return arguments_[index + 1]
}

try {
  if (command === 'keygen') {
    const outputDir = resolve(option('--out') ?? '.bibit-keys')
    const keyId = option('--key-id') ?? 'development'
    const result = await generatePluginSigningKey({ outputDir, keyId })
    console.log(`Private key: ${result.privateKeyPath}`)
    console.log(`Trust entry: ${result.trustEntryPath}`)
    console.log(`Development trust store: ${result.trustStorePath}`)
  } else if (command === 'build') {
    const privateKeyPath = option('--key')
    const keyId = option('--key-id')
    if (!privateKeyPath || !keyId) {
      throw new Error('build requires --key <private.pem> and --key-id <id>')
    }
    const result = await buildPluginBundle({
      cwd: process.cwd(),
      privateKeyPath: resolve(privateKeyPath),
      keyId,
    })
    console.log(`Plugin bundle: ${result.bundlePath}`)
  } else {
    throw new Error(
      'Usage: bibit-plugin keygen [--out DIR] [--key-id ID] | build --key FILE --key-id ID'
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
