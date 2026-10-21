import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..')
const repo = join(bundle, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-orb-install-'))

after(() => { rmSync(scratch, { recursive: true, force: true }) })

/** Plugin names the patch inserts that belong to this package. */
function ownNames() {
  const patch = readFileSync(join(bundle, 'cordis.patch.yml'), 'utf8')
  const names = [...patch.matchAll(/^\s+name: '?(dsh-orb[^'\s]*)'?\s*$/gm)].map((match) => match[1])
  return [...new Set(names)]
}

/** The loader resolves a patch row from the profile root, the same as this. */
function resolveFromProfile(profile, specifier) {
  return createRequire(join(profile, 'package.json')).resolve(specifier)
}

function profileWith(install) {
  const profile = mkdtempSync(join(scratch, 'profile-'))
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  install(join(profile, 'node_modules', 'dsh-orb'))
  return profile
}

function checkInstalled(profile, root) {
  const names = ownNames()
  assert.deepEqual(names.sort(), [
    'dsh-orb',
    'dsh-orb/computer-use',
    'dsh-orb/computer-use/code-agent',
    'dsh-orb/computer-use/code-agent-registry',
    'dsh-orb/host',
  ])
  for (const specifier of names) {
    const file = resolveFromProfile(profile, specifier)
    assert.ok(existsSync(file), `${specifier} -> ${file}`)
  }

  // dsh-client-modules: nearest manifest carries the package name, declares dsh.client, exports ./client.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-orb')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
  assert.equal(manifest.exports['./client'], './client.js')
  assert.match(readFileSync(join(root, 'client.js'), 'utf8'), /id: 'dsh-orb'/)

  // Files the host reaches by relative path.
  for (const rel of [
    'dist/helper/lib/main.js',
    'dist/helper/assets/observation-frame.html',
    'dist/helper/assets/observation-frame.css',
    'dist/computer-use/macos-sck-capture',
    'runtime/run-with-evidence.ps1',
    'runtime/run-with-evidence.cmd',
    'runtime/read-evidence.ps1',
    'runtime/read-evidence.cmd',
  ]) {
    assert.ok(existsSync(join(root, rel)), rel)
  }
  // The floating ball, selection toolbar, avatars, and their vendor bundles
  // are not part of this build.
  for (const rel of [
    'dist/helper/preload.cjs',
    'dist/helper/selection-preload.cjs',
    'dist/helper/assets/floating.html',
    'dist/helper/assets/deepseek-avatar-square.gif',
    'dist/helper/assets/avatars',
    'dist/helper/assets/vendor',
    'dist/native-selection',
  ]) {
    assert.equal(existsSync(join(root, rel)), false, `${rel} must not ship`)
  }
  const host = readFileSync(join(root, 'dist/host/index.js'), 'utf8')
  assert.match(host, /new URL\("\.\.\/helper", import\.meta\.url\)/)
  assert.equal(host.includes('native-selection'), false)
  assert.equal(host.includes('floating-session'), false)
  assert.equal(readdirSync(join(root, 'dist/host')).includes('index.js'), true)
}

/** A link a test can create: junctions need no privilege on Windows, symlinks do. */
function linkDir(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('dsh-orb install layout', () => {
  // Assembled into a scratch folder so a linked desktop install is never rewritten while it runs.
  const assembled = join(scratch, 'assembled')
  before(() => {
    const built = spawnSync(process.execPath, [join(bundle, 'scripts/assemble.mjs'), '--out', assembled], { stdio: 'pipe', encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    // A real link resolves dependencies from the package's own folder; give the copy the same view.
    linkDir(join(bundle, 'node_modules'), join(assembled, 'node_modules'))
  })

  it('resolves every patch row from the profile root when the folder is linked', async () => {
    const profile = profileWith((target) => linkDir(assembled, target))
    checkInstalled(profile, join(profile, 'node_modules', 'dsh-orb'))
    const host = await import(pathToFileURL(resolveFromProfile(profile, 'dsh-orb/host')).href)
    assert.equal(typeof host.apply, 'function')
    assert.equal(host.name, 'orb-host')
  })

  it('keeps the repository client.js in step with the settings source', () => {
    // A `link:` install reads this copy directly; assemble only rewrites it during a build.
    // A fresh clone has none until then, and the assembled copy is checked below, so an
    // absent file is not a failure here.
    const linked = join(bundle, 'client.js')
    if (!existsSync(linked)) return
    const source = readFileSync(join(repo, 'packages/client-settings/client.js'), 'utf8')
    const text = readFileSync(linked, 'utf8')
    assert.doesNotMatch(text, /updateDeferred|update\.deferred/u)
    assert.match(text, /frame\/restart/u)
    // Only the module id differs from the source it is assembled from.
    assert.equal(text, source.replace("id: '@dsh-orb/client-ui-settings-orb'", "id: 'dsh-orb'"))
  })

  it('does not carry the retired update or floating-ball UI in the assembled settings page', () => {
    const text = readFileSync(join(assembled, 'client.js'), 'utf8')
    assert.doesNotMatch(text, /updateDeferred|update\.deferred|启用悬浮球|悬浮球头像|检查更新/u)
    assert.match(text, /观察框彩带/u)
    assert.match(text, /frame\/restart/u)
  })

  it('resolves every patch row when the tarball is unpacked into the profile', () => {
    // A test-only version keeps the pack away from a release tarball waiting in the
    // repository root: the pack writes `dsh-orb-<version>.tgz` there and this test deletes it.
    const testVersion = '0.0.0-test'
    const packed = spawnSync(process.execPath, [join(bundle, 'scripts/pack.mjs'), '--version', testVersion], { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const tarball = join(repo, `dsh-orb-${testVersion}.tgz`)
    assert.ok(existsSync(tarball))
    try {
      const profile = profileWith((target) => {
        mkdirSync(target, { recursive: true })
        // Extract by bare name beside the cwd: GNU tar (Git for Windows) reads a
        // drive-letter path in `-f` or `-C` as a remote host, so no absolute
        // path may reach tar.
        const local = join(target, basename(tarball))
        copyFileSync(tarball, local)
        try {
          const untar = spawnSync('tar', ['-xzf', basename(tarball), '--strip-components=1'], { cwd: target, encoding: 'utf8' })
          assert.equal(untar.status, 0, untar.stderr)
        } finally {
          rmSync(local, { force: true })
        }
      })
      const root = join(profile, 'node_modules', 'dsh-orb')
      checkInstalled(profile, root)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      assert.equal(manifest.devDependencies, undefined)
      assert.equal(manifest.scripts, undefined)
      // Self-contained: no dependency resolves from a registry. The runtime deps ship
      // inside the package (koffi with its platform prebuilds, scriptless so pnpm has
      // nothing to gate); the @deepseek-ai peers stay declared for the host's check.
      assert.equal(manifest.dependencies, undefined)
      assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).length > 0, true)
      for (const rel of [
        'node_modules/koffi/package.json',
        'node_modules/zod/package.json',
        'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
        'node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node',
        'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
      ]) {
        assert.ok(existsSync(join(root, rel)), rel)
      }
      const koffi = JSON.parse(readFileSync(join(root, 'node_modules/koffi/package.json'), 'utf8'))
      assert.equal(koffi.scripts, undefined, 'no install script for pnpm to gate')
    } finally {
      rmSync(tarball, { force: true })
    }
  })
})
