import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('published defaults and local overrides preserve explicit configuration precedence', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const fixture = mkdtempSync(join(tmpdir(), 'sekaisync-config-'))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('SEKAISYNC_')) delete env[key]
  const read = (extraEnv = {}, row = null) => {
    const code = `import { loadConfig, setRuntimeConfig, dispose } from './lib/backend.js';
      setRuntimeConfig(${JSON.stringify(row)});
      console.log(JSON.stringify(loadConfig())); dispose();`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: fixture, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  try {
    mkdirSync(join(fixture, 'lib'))
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}')
    for (const file of ['backend.js', 'runtime.js']) copyFileSync(join(root, 'lib', file), join(fixture, 'lib', file))
    copyFileSync(join(root, 'config.json'), join(fixture, 'config.json'))
    const defaults = read()
    assert.equal(defaults.store, null)
    assert.equal(defaults.root, null)
    assert.equal(defaults.externalPort, 8787)
    assert.equal(defaults.maxResponseBytes, 128 * 1024 * 1024)
    writeFileSync(join(fixture, 'config.local.json'), JSON.stringify({ store: 'local-store', root: 'local-root' }))
    assert.equal(read().store, 'local-store')
    const explicit = join(fixture, 'explicit.json')
    writeFileSync(explicit, JSON.stringify({ store: 'explicit-store' }))
    assert.equal(read({ SEKAISYNC_CONFIG: explicit }).store, 'explicit-store')
    assert.equal(read({ SEKAISYNC_CONFIG: explicit }, { store: 'profile-store' }).store, 'profile-store')
    assert.equal(read({ SEKAISYNC_CONFIG: explicit, SEKAISYNC_STORE: 'env-store' }, { store: 'profile-store' }).store, 'env-store')
    assert.equal(read({}, { store: '' }).store, 'local-store')
    writeFileSync(join(fixture, 'config.local.json'), 'invalid JSON')
    assert.equal(read().store, null)
  } finally {
    // Delete only this test's exact temporary fixture.
    rmSync(fixture, { recursive: true, force: true })
  }
})
