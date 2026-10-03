import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBackendRoot } from './backend-root.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sekaisync-backend-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function backend(root) {
  mkdirSync(join(root, 'sekaisync'), { recursive: true })
  writeFileSync(join(root, 'sekaisync', 'cli.py'), '# fixture backend marker\n')
  return root
}

test('explicit backend argument wins over environment and checkout discovery', (t) => {
  const root = fixture(t)
  const explicit = backend(join(root, 'arbitrary-backend-name'))
  const mounted = backend(join(root, 'mounted-backend'))
  assert.equal(resolveBackendRoot({
    argument: 'arbitrary-backend-name', envRoot: join(root, 'invalid-env'),
    pluginRoot: join(mounted, 'agents', 'plugin'), cwd: root,
  }), explicit)
})

test('environment backend wins over checkout discovery and accepts relative paths', (t) => {
  const root = fixture(t)
  const configured = backend(join(root, 'configured-backend'))
  const mounted = backend(join(root, 'mounted-backend'))
  assert.equal(resolveBackendRoot({
    envRoot: 'configured-backend', pluginRoot: join(mounted, 'agents', 'plugin'), cwd: root,
  }), configured)
})

test('mounted plugin discovers the nearest backend ancestor without depending on its name', (t) => {
  const root = backend(fixture(t))
  const nearest = backend(join(root, 'custom-source-location'))
  assert.equal(resolveBackendRoot({
    envRoot: '', pluginRoot: join(nearest, 'agents', 'deepseek-harness'),
  }), nearest)
})

for (const name of ['sekaisync-cli', 'sekaisync']) {
  test(`standalone plugin discovers the conventional ${name} sibling`, (t) => {
    const root = fixture(t)
    const expected = backend(join(root, name))
    assert.equal(resolveBackendRoot({
      envRoot: '', pluginRoot: join(root, 'dsh-sekaisync-connect'),
    }), expected)
  })
}

test('an invalid explicit argument never falls back to environment or checkout discovery', (t) => {
  const root = backend(fixture(t))
  for (const argument of ['missing-backend', '']) {
    assert.throws(() => resolveBackendRoot({
      argument, envRoot: root, pluginRoot: join(root, 'agents', 'plugin'), cwd: root,
    }), /backend-root argument must point to a backend checkout containing sekaisync\/cli\.py/)
  }
})

test('an invalid environment backend never falls back to checkout discovery', (t) => {
  const root = backend(fixture(t))
  assert.throws(() => resolveBackendRoot({
    envRoot: join(root, 'missing-backend'), pluginRoot: join(root, 'agents', 'plugin'),
  }), /SEKAISYNC_ROOT must point to a backend checkout containing sekaisync\/cli\.py/)
})

test('a directory named cli.py is not a backend source marker', (t) => {
  const root = fixture(t)
  mkdirSync(join(root, 'invalid-source', 'sekaisync', 'cli.py'), { recursive: true })
  assert.throws(() => resolveBackendRoot({
    argument: join(root, 'invalid-source'), envRoot: '', pluginRoot: join(root, 'plugin'),
  }), /backend-root argument must point to a backend checkout/)
})

test('missing automatic candidates report explicit setup options', (t) => {
  const root = fixture(t)
  assert.throws(() => resolveBackendRoot({
    envRoot: '', pluginRoot: join(root, 'plugin'),
  }), /Pass <backend-root> or set SEKAISYNC_ROOT/)
})
