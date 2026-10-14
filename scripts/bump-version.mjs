#!/usr/bin/env node
/**
 * Raise the BiBit release version everywhere it is recorded.
 *
 * Usage: node scripts/bump-version.mjs <major.minor.patch[-beta.N]> [changelog entry]
 *        node scripts/bump-version.mjs --check
 *
 * debian/rules runs --check before building, because dpkg-source strips files
 * like .gitignore from the build tree and the repo-wide packaging test cannot
 * run there. Bump the carriers in one step instead of editing them by hand;
 * running the script again with the recorded version repairs whichever carrier
 * drifted and leaves the others alone.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [target = '', message = 'Sync version for packaging'] = process.argv.slice(2)
if (target !== '--check' && !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(target)) {
  console.error(
    'usage: node scripts/bump-version.mjs <major.minor.patch[-beta.N]> [changelog entry]\n' +
      '       node scripts/bump-version.mjs --check'
  )
  process.exit(2)
}

const debianTarget = target.replace('-beta.', '~beta')

const root = fileURLToPath(new URL('..', import.meta.url))
const carriers = [
  {
    file: 'web-app/package.json',
    pattern: /"version": "[^"]*"/,
    version: /"version": "([^"]*)"/,
    replacement: `"version": "${target}"`,
  },
  {
    file: 'package.json',
    pattern: /"version": "[^"]*"/,
    version: /"version": "([^"]*)"/,
    replacement: `"version": "${target}"`,
  },
  {
    file: 'src-tauri/Cargo.toml',
    pattern: /^version = "[^"]*"$/m,
    version: /^version = "([^"]*)"$/m,
    replacement: `version = "${target}"`,
  },
  {
    file: 'src-tauri/Cargo.lock',
    pattern: /(name = "BiBit"\nversion = )"[^"]*"/,
    version: /(?:name = "BiBit"\nversion = )"([^"]*)"/,
    replacement: `$1"${target}"`,
  },
  {
    file: 'src-tauri/tauri.conf.json',
    pattern: /"version": "[^"]*"/,
    version: /"version": "([^"]*)"/,
    replacement: `"version": "${target}"`,
  },
]

const readVersion = ({ file, version }) => {
  const found = version.exec(readFileSync(`${root}${file}`, 'utf8'))?.[1]
  if (!found) {
    console.error(`${file}: no version field matched, refusing to guess`)
    process.exit(1)
  }
  return found
}

const changelogPath = `${root}debian/changelog`
const changelog = readFileSync(changelogPath, 'utf8')
const currentVersion = /^bibit \(([^)]+)\)/m.exec(changelog)?.[1]
if (!currentVersion) {
  console.error('debian/changelog: cannot read the current version')
  process.exit(1)
}

if (target === '--check') {
  const recorded = { 'debian/changelog': currentVersion.replace('~beta', '-beta.') }
  for (const carrier of carriers) recorded[carrier.file] = readVersion(carrier)
  const distinct = [...new Set(Object.values(recorded))]
  if (distinct.length > 1) {
    console.error('release version drifted:')
    for (const [file, version] of Object.entries(recorded)) {
      console.error(`  ${file}: ${version}`)
    }
    process.exit(1)
  }
  console.log(
    `release version ${distinct[0]} agrees across debian/changelog, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json, package.json and web-app/package.json`
  )
  process.exit(0)
}

const edits = carriers.map(({ file, pattern, replacement }) => {
  const path = `${root}${file}`
  const before = readFileSync(path, 'utf8')
  if (!pattern.test(before)) {
    console.error(`${file}: no version field matched, refusing to guess`)
    process.exit(1)
  }
  return { file, path, before, after: before.replace(pattern, replacement) }
})

const comparison = spawnSync('dpkg', ['--compare-versions', currentVersion, 'gt', debianTarget])
if (comparison.error || ![0, 1].includes(comparison.status)) {
  console.error('debian/changelog: cannot compare package versions, refusing to update')
  process.exit(1)
}

if (currentVersion === debianTarget) {
  console.log(`debian/changelog: already ${target}`)
} else if (comparison.status === 0) {
  console.error(`debian/changelog: ${currentVersion} is ahead of ${target}, roll back by hand`)
  process.exit(1)
} else {
  const maintainer = /^ -- (.+?) {2}\S.*$/m.exec(changelog)[1]
  const date = execFileSync('date', ['-R'], { encoding: 'utf8' }).trim()
  const entry = `bibit (${debianTarget}) UNRELEASED; urgency=medium\n\n  * ${message}\n\n -- ${maintainer}  ${date}\n\n`
  writeFileSync(changelogPath, entry + changelog)
  console.log(`debian/changelog: ${currentVersion} -> ${target}`)
}

for (const { file, path, before, after } of edits) {
  if (before === after) {
    console.log(`${file}: already ${target}`)
  } else {
    writeFileSync(path, after)
    console.log(`${file}: updated to ${target}`)
  }
}

try {
  execFileSync('node', ['--test', 'scripts/linux-deb-config.test.mjs'], {
    cwd: root,
    stdio: 'inherit',
  })
} catch {
  console.error('\nPackaging checks failed: the version carriers do not agree yet.')
  process.exit(1)
}
