import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import test from 'node:test'

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const packageJson = readJson(new URL('../package.json', import.meta.url))
const linuxConfig = readJson(
  new URL('../src-tauri/tauri.linux.conf.json', import.meta.url)
)
const tauriConfig = readJson(
  new URL('../src-tauri/tauri.conf.json', import.meta.url)
)
const cargoToml = readFileSync(
  new URL('../src-tauri/Cargo.toml', import.meta.url),
  'utf8'
)
const rustApp = readFileSync(
  new URL('../src-tauri/src/lib.rs', import.meta.url),
  'utf8'
)
const conversationRuntime = readFileSync(
  new URL('../src-tauri/src/status_popup/conversation.rs', import.meta.url),
  'utf8'
)
const buildRs = readFileSync(
  new URL('../src-tauri/build.rs', import.meta.url),
  'utf8'
)
const rootRoute = readFileSync(
  new URL('../web-app/src/routes/__root.tsx', import.meta.url),
  'utf8'
)
const windowControls = readFileSync(
  new URL('../web-app/src/components/WindowControls.tsx', import.meta.url),
  'utf8'
)
const statusPopupController = readFileSync(
  new URL('../src-tauri/src/status_popup/controller.rs', import.meta.url),
  'utf8'
)
const voiceOverlay = readFileSync(
  new URL('../src-tauri/src/voice_overlay.rs', import.meta.url),
  'utf8'
)
const windowService = readFileSync(
  new URL('../web-app/src/services/window/tauri.ts', import.meta.url),
  'utf8'
)
const yarnRc = readFileSync(new URL('../.yarnrc.yml', import.meta.url), 'utf8')
const debianControl = readFileSync(
  new URL('../debian/control', import.meta.url),
  'utf8'
)
const debianRules = readFileSync(
  new URL('../debian/rules', import.meta.url),
  'utf8'
)
const debianSourceFormat = readFileSync(
  new URL('../debian/source/format', import.meta.url),
  'utf8'
)
const debianBianbuConfig = readFileSync(
  new URL('../debian/bianbu.conf', import.meta.url),
  'utf8'
)
const debianChangelog = readFileSync(
  new URL('../debian/changelog', import.meta.url),
  'utf8'
)
const debianCopyright = readFileSync(
  new URL('../debian/copyright', import.meta.url),
  'utf8'
)
const debianLintianOverrides = readFileSync(
  new URL('../debian/bi-bit.lintian-overrides', import.meta.url),
  'utf8'
)
const vendoredYarnUrl = new URL(
  '../.yarn/releases/yarn-4.5.3.cjs',
  import.meta.url
)
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const defaultCapability = readJson(
  new URL('../src-tauri/capabilities/default.json', import.meta.url)
)
const desktopCapability = readJson(
  new URL('../src-tauri/capabilities/desktop.json', import.meta.url)
)

test('Linux bundle only targets Debian and excludes Jan runtime files', () => {
  assert.deepEqual(linuxConfig.bundle.targets, ['deb'])
  assert.equal('externalBin' in linuxConfig.bundle, false)
  assert.doesNotMatch(
    cargoToml,
    /\[\[bin\]\]\s+name = "bibit-fake-acp-agent"/s
  )
  assert.equal(
    existsSync(
      new URL('../src-tauri/src/bin/bibit_fake_acp_agent.rs', import.meta.url)
    ),
    false
  )
  assert.equal(JSON.stringify(linuxConfig).includes('jan-cli'), false)
  assert.equal(JSON.stringify(linuxConfig).includes('resources/bin/bun'), false)
  assert.equal(JSON.stringify(linuxConfig).includes('appimage'), false)
})

test('desktop windows keep the WebView inspector out of reach', () => {
  // The deb ships a debug build, and Tauri enables WebKit developer extras by
  // default there — that switch is what puts “Inspect Element” in the WebKit
  // context menu. Every Bibit window opts out explicitly.
  const mainWindow = linuxConfig.app.windows.find(
    (window) => window.label === 'main'
  )
  assert.equal(mainWindow?.devtools, false)
  assert.equal((statusPopupController.match(/\.devtools\(false\)/g) ?? []).length, 1)
  assert.equal((voiceOverlay.match(/\.devtools\(false\)/g) ?? []).length, 2)
  assert.match(windowService, /devtools: false/)
})

test('Linux bundle ships the third-party license manifest and the plugin trust store', () => {
  // tauri-utils merges tauri.<platform>.conf.json into the base config with RFC
  // 7396 semantics, so an array in the platform overlay replaces the base array
  // instead of extending it. The stale copy of bundle.resources that used to
  // live in tauri.linux.conf.json left resources/plugin-trusted-keys.json out
  // of the deb, and a release build cannot verify a plugin bundle without it.
  assert.equal('resources' in linuxConfig.bundle, false)
  assert.ok(
    tauriConfig.bundle.resources.includes('resources/LICENSES/THIRD-PARTY.json')
  )
  assert.ok(
    tauriConfig.bundle.resources.includes('resources/plugin-trusted-keys.json')
  )
  assert.match(
    packageJson.scripts['copy:assets:tauri'],
    /LICENSES\/\*.*src-tauri\/resources\/LICENSES/
  )
})

test('desktop binary exposes the bibit-gui command', () => {
  assert.match(cargoToml, /default-run = "bibit-gui"/)
  assert.match(cargoToml, /autobins = false/)
  assert.match(
    cargoToml,
    /\[\[bin\]\]\s+name = "bibit-gui"\s+path = "src\/main\.rs"/s
  )
  assert.doesNotMatch(cargoToml, /\[\[bin\]\]\s+name = "jan-cli"/s)
  assert.equal(
    existsSync(new URL('../src-tauri/src/bin/jan-cli.rs', import.meta.url)),
    false
  )
  assert.equal(
    existsSync(new URL('../src-tauri/cli/jan-cli.rs', import.meta.url)),
    false
  )
})

test('production builds exclude demo Runtime commands', () => {
  const defaultFeatures = cargoToml.match(/default = \[(.*?)\]\n/s)?.[1] ?? ''
  assert.doesNotMatch(defaultFeatures, /demo-runtime/)
  assert.match(cargoToml, /demo-runtime = \[\]/)
  assert.match(
    rustApp,
    /#\[cfg\(feature = "demo-runtime"\)\]\s+pub mod demo_runtime;/
  )
  assert.match(
    rustApp,
    /#\[cfg\(feature = "demo-runtime"\)\]\s+demo_runtime::commands::start_demo_runtime/
  )
  assert.match(packageJson.scripts['dev:tauri'], /--features demo-runtime/)
  assert.doesNotMatch(packageJson.scripts['build:deb:linux'], /demo-runtime/)
  assert.match(
    conversationRuntime,
    /#\[cfg\(feature = "demo-runtime"\)\]\s+use crate::demo_runtime::DemoRuntimeEvent;/
  )
  assert.match(
    conversationRuntime,
    /#\[cfg\(feature = "demo-runtime"\)\]\s+fn demo_runtime_envelope/
  )
})

test('the Hermes driver and Fake Agent integration targets enable desktop support', () => {
  assert.match(cargoToml, /test-tauri = \[(?:.|\n)*?"desktop"/)
})

test('Debian package exposes the bibit CLI wrapper', () => {
  const wrapperUrl = new URL('../src-tauri/resources/bibit', import.meta.url)

  assert.equal(
    linuxConfig.bundle.linux.deb.files['/usr/bin/bibit'],
    'resources/bibit'
  )
  assert.equal(existsSync(wrapperUrl), true)
  assert.notEqual(statSync(wrapperUrl).mode & 0o111, 0)
  assert.equal(
    readFileSync(wrapperUrl, 'utf8'),
    '#!/bin/sh\nexec "$(dirname "$0")/bibit-gui" --cli "$@"\n'
  )
})

test('Debian package installs the themed status tray icon', () => {
  assert.equal(
    linuxConfig.bundle.linux.deb.files[
      '/usr/share/icons/hicolor/scalable/apps/bibit-status.svg'
    ],
    'static/tray-icon.svg'
  )
  assert.doesNotMatch(debianRules, /bibit-status\.svg/)
})

test('Debian package declares the Bianbu GLES runtime dependencies', () => {
  assert.deepEqual(linuxConfig.bundle.linux.deb.depends, [
    'bibit-voice',
    'bibit-runtime-plugin',
    'bibit-filesearch-plugin',
    'bibit-agenthub-plugin',
    'bibit-memory-plugin',
    'bianbu-agent-runtime',
    'libgtk-layer-shell0',
    'libegl1',
    'libgles2',
    'libgtk-3-0t64',
    'libegl-pvr0',
    'libgbm1-pvr',
    'libgl1-pvr-dri',
    'libglapi-pvr',
  ])
})

test('both Debian package paths depend on the integrated Bibit services', () => {
  assert.doesNotMatch(debianControl, /bibit-security-plugin/)
  for (const dependency of [
    'bibit-voice',
    'bibit-runtime-plugin',
    'bibit-filesearch-plugin',
    'bibit-agenthub-plugin',
    'bibit-memory-plugin',
    'bianbu-agent-runtime',
  ]) {
    assert.match(debianControl, new RegExp(`(?:^|[, ])${dependency}(?:[, ]|$)`))
  }
})

test('Debian source tree preserves the GLES runtime contract', () => {
  assert.match(debianControl, /Package: bi-bit/)
  assert.match(debianControl, /Architecture: riscv64/)
  for (const dependency of [
    'libgtk-3-0t64',
    'libegl1',
    'libgles2',
    'libegl-pvr0',
    'libgbm1-pvr',
    'libgl1-pvr-dri',
    'libglapi-pvr',
  ]) {
    assert.match(debianControl, new RegExp(dependency))
  }
  assert.match(debianRules, /dpkg-deb -x/)
  assert.doesNotMatch(debianRules, /dpkg-deb -e/)
  assert.doesNotMatch(debianRules, /\/DEBIAN/)
  assert.match(debianRules, /DEB_HOST_ARCH/)
  assert.match(debianRules, /DEB_VERSION_UPSTREAM/)
  assert.doesNotMatch(debianRules, /BiBit_0\.8\.4_/)
  assert.match(
    debianRules,
    /target_dir=\$\$\{CARGO_TARGET_DIR:-src-tauri\/target\}/
  )
  assert.match(debianRules, /debug\/bundle\/deb\//)
})

test('Debian source builds use the vendored Yarn release', () => {
  assert.match(gitignore, /^\.yarn$/m)
  assert.match(gitignore, /^!\/\.yarn\/$/m)
  assert.match(gitignore, /^!\/\.yarn\/releases\/yarn-4\.5\.3\.cjs$/m)
  assert.doesNotMatch(debianControl, /\byarnpkg\b/)
  assert.doesNotMatch(debianControl, /\bnode-corepack\b/)
  assert.match(
    debianControl,
    /Build-Depends:[\s\S]*?\bnodejs\b[\s\S]*?\nStandards-Version:/
  )
  assert.match(
    debianRules,
    /node \.yarn\/releases\/yarn-4\.5\.3\.cjs build:deb:linux/
  )
  assert.match(
    debianRules,
    /node \.yarn\/releases\/yarn-4\.5\.3\.cjs install --immutable/
  )
  assert.equal(existsSync(vendoredYarnUrl), true)
  if (existsSync(vendoredYarnUrl)) {
    assert.equal(
      createHash('sha256').update(readFileSync(vendoredYarnUrl)).digest('hex'),
      'dddc0b96ad2dca8d56a5302b56bf3cbf8210654474a6bf88877da61e866f3d46'
    )
  }
})

test('Debian source declares every native and Yarn build dependency', () => {
  const buildDepends = debianControl
    .match(/Build-Depends:\s*([\s\S]*?)\nStandards-Version:/)?.[1]
    .replace(/\s+/g, ' ')

  assert.ok(buildDepends)
  for (const dependency of [
    'ca-certificates',
    'python3',
    'pkgconf',
    'libdbus-1-dev',
    'libgtk-3-dev',
    'libgtk-layer-shell-dev',
    'libwebkit2gtk-4.1-dev',
    'libayatana-appindicator3-dev',
    'librsvg2-dev',
    'libssl-dev',
    'libxdo-dev',
  ]) {
    assert.match(buildDepends, new RegExp(`(?:^|[, ])${dependency}(?:[, ]|$)`))
  }

  assert.match(buildDepends, /cargo \(>= 1\.88\)/)
  assert.match(buildDepends, /rustc \(>= 1\.88\)/)
  assert.match(buildDepends, /nodejs \(>= 18\.12\)/)
})

test('Debian binary package consumes debhelper dependency substitutions', () => {
  assert.match(debianControl, /Depends:[^\n]*\$\{shlibs:Depends\}/)
  assert.match(debianControl, /Depends:[^\n]*\$\{misc:Depends\}/)
})

test('Debian package ships copyright metadata and documents the Rust libyaml override', () => {
  assert.match(debianCopyright, /^Format: https:\/\/www\.debian\.org\/doc\/packaging-manuals\/copyright-format\/1\.0\//)
  assert.match(debianCopyright, /Copyright: 2025 Menlo Research/)
  assert.match(
    debianCopyright,
    /Files: \.yarn\/releases\/yarn-4\.5\.3\.cjs[\s\S]*?Copyright: 2016-present, Yarn Contributors[\s\S]*?License: BSD-2-Clause/
  )
  assert.match(
    debianLintianOverrides,
    /embedded-library libyaml \[usr\/bin\/bibit-gui\]/
  )
})

test('Debian source format matches the native package version', () => {
  assert.equal(debianSourceFormat, '3.0 (native)\n')
  const debianVersion = debianChangelog.match(/^bibit \(([^)]+)\) /)?.[1]
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1]

  assert.equal(debianVersion, tauriConfig.version.replace('-beta.', '~beta'))
  assert.equal(cargoVersion, tauriConfig.version)
  assert.equal(packageJson.version, tauriConfig.version)
  assert.equal(readJson(new URL('../web-app/package.json', import.meta.url)).version, tauriConfig.version)
})

test('Bianbu packaging metadata targets the native resolute suite', () => {
  assert.match(debianBianbuConfig, /^\[package\]$/m)
  assert.match(debianBianbuConfig, /^upstream\s*=\s*False$/m)
  assert.match(debianBianbuConfig, /^targetsuite\s*=\s*resolute-customization$/m)
})

test('Debian clean does not invoke the destructive project clean target', () => {
  assert.match(debianRules, /override_dh_auto_clean:\n\t:/)
})

test('README documents the standard Debian source build command', () => {
  assert.match(readme, /sudo apt build-dep \./)
  assert.match(readme, /dpkg-checkbuilddeps/)
  assert.match(readme, /dpkg-buildpackage -us -uc -b/)
  const version = debianChangelog.match(/^bibit \(([^)]+)\)/)?.[1]
  assert.ok(readme.includes(`../bi-bit_${version}_riscv64.deb`))
})

test('Debian builds inherit dpkg-buildpackage parallelism', () => {
  assert.match(debianRules, /^export YARN_TASK_POOL_CONCURRENCY := 1$/m)
  assert.match(debianRules, /^\t\+AUTO_UPDATER_DISABLED=true \\\n/m)
  assert.doesNotMatch(debianRules, /CARGO_BUILD_JOBS=.*:-8/)
  assert.doesNotMatch(debianRules, /MAKEFLAGS=.*:-j8/)
})

test('package script builds icons, licenses and Debian bundle', () => {
  assert.equal(
    packageJson.scripts['build:deb:linux'],
    'yarn feature:registry && yarn build:tauri:plugin:api && yarn build:extensions && yarn build:icon && yarn copy:assets:tauri && cross-env IS_CLEAN=true IS_TAURI=true IS_DEV=false AUTO_UPDATER_DISABLED=true TAURI_ENV_PLATFORM=linux tauri build --debug --bundles deb --features allow-unsigned-plugins'
  )
})

test('Linux desktop debug builds prerequisites and exposes the Security demo command', () => {
  assert.equal(
    packageJson.scripts['dev:tauri'],
    'yarn feature:registry && yarn build:tauri:plugin:api && yarn build:extensions && yarn build:icon && yarn copy:assets:tauri && cross-env IS_CLEAN=true AUTO_UPDATER_DISABLED=true tauri dev --features demo-runtime'
  )
  assert.equal(
    packageJson.scripts['dev:security-demo'],
    'cross-env BIBIT_HERMES_ACP_EXPERIMENTAL=true BIBIT_SECURITY_DEMO=true yarn dev:tauri'
  )
})

test('Linux web builds and Cargo builds guard the window controls artifact', () => {
  assert.equal(
    packageJson.scripts['build:web:linux'],
    'cross-env IS_TAURI=true IS_DEV=false TAURI_ENV_PLATFORM=linux yarn build:web && node scripts/verify-linux-window-controls.mjs web-app/dist'
  )
  assert.match(buildRs, /verify-linux-window-controls\.mjs/)
  assert.match(buildRs, /std::env::var\("PROFILE"\)/)
  assert.match(buildRs, /linux_window_controls_build::should_verify/)
  assert.match(rootRoute, /IS_LINUX[\s\S]*<WindowControls \/>/)
  assert.doesNotMatch(rootRoute, /bibit-linux-window-controls-v1/)
  assert.match(windowControls, /data-bibit-build-marker/)
  assert.match(windowControls, /bibit-linux-window-controls-v1/)
})

test('the Tauri updater is never initialized', () => {
  // The updater plugin was removed from the app entirely, which also removes the
  // unsigned-build hazard the previous guard covered. Keep it from coming back.
  assert.doesNotMatch(rustApp, /tauri_plugin_updater/)
  assert.doesNotMatch(cargoToml, /tauri-plugin-updater/)
})

test('main-window capabilities do not authorize remote web content', () => {
  for (const capability of [defaultCapability, desktopCapability]) {
    assert.deepEqual(capability.windows, ['main'])
    assert.equal('remote' in capability, false)
  }
})

test('Yarn installs the Rolldown WASI fallback for RISC-V builds', () => {
  assert.match(
    yarnRc,
    /supportedArchitectures:\s*\n\s+cpu:\s*\n\s+- current\s*\n\s+- wasm32(?:\s*\n|$)/
  )
})

test('Tailwind uses the Lightning CSS WASM build on RISC-V', () => {
  assert.equal(
    packageJson.resolutions?.lightningcss,
    'npm:lightningcss-wasm@1.29.2'
  )
})

test('Core and extension builds use the RISC-V-safe Rolldown runner', () => {
  const workspaces = [
    ['../core/package.json', 'tsc -p . && node ../scripts/rolldown-build.mjs rolldown.config.mjs'],
    ['../extensions/assistant-extension/package.json', 'node ../../scripts/rolldown-build.mjs rolldown.config.mjs'],
    ['../extensions/conversational-extension/package.json', 'node ../../scripts/rolldown-build.mjs rolldown.config.mjs'],
    ['../extensions/download-extension/package.json', 'node ../../scripts/rolldown-build.mjs rolldown.config.mjs'],
    ['../extensions/llamacpp-extension/package.json', 'node ../../scripts/rolldown-build.mjs rolldown.config.mjs'],
    ['../extensions/rag-extension/package.json', 'node ../../scripts/rolldown-build.mjs rolldown.config.mjs'],
    ['../extensions/vector-db-extension/package.json', 'node ../../scripts/rolldown-build.mjs rolldown.config.mjs'],
  ]

  for (const [path, expectedBuild] of workspaces) {
    assert.equal(readJson(new URL(path, import.meta.url)).scripts.build, expectedBuild)
  }
})

test('Web builds use the RISC-V-safe Vite runner', () => {
  assert.equal(
    readJson(new URL('../web-app/package.json', import.meta.url)).scripts.build,
    'yarn feature:registry && tsc -b && node ../scripts/vite-build.mjs'
  )
})

test('legacy main-window floating mode is removed', () => {
  const removed = [
    '../web-app/src/components/WindowModeToggle.tsx',
    '../web-app/src/lib/window-mode.ts',
    '../web-app/src/lib/__tests__/window-mode.test.ts',
    '../web-app/src/stores/window-mode-store.ts',
    '../web-app/src/stores/__tests__/window-mode-store.test.ts',
  ]

  for (const path of removed) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false)
  }
})
