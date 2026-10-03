// lib/deploy.js 的单元测试：路径分类、候选探测与有界目录列表。
// 全部离线（不联网、不起 sekaisync 子进程），只碰临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { classifyPath, formatBytes, hasSekaiSyncSource } from '../lib/deploy.js'

/** 造一个最小的可用 store：<root>/store/kb/sekaisync.db */
function makeStore(root, { withDb = true, extraKb = [] } = {}) {
  const store = join(root, 'store')
  mkdirSync(join(store, 'kb'), { recursive: true })
  if (withDb) writeFileSync(join(store, 'kb', 'sekaisync.db'), Buffer.alloc(2048, 7))
  for (const name of extraKb) writeFileSync(join(store, 'kb', name), '{}')
  mkdirSync(join(root, 'sekaisync'), { recursive: true })
  writeFileSync(join(root, 'sekaisync', '__init__.py'), '')
  return store
}

test('classifyPath accepts a store directory, a repo root, and a kb directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'sks-deploy-'))
  try {
    const store = makeStore(root, { extraKb: ['registry.json'] })
    writeFileSync(join(store, 'kb', 'freshness.json'), JSON.stringify({ jp: '2026-09-28' }))

    const asStore = classifyPath(store)
    assert.equal(asStore.ok, true)
    assert.equal(asStore.kind, 'store')
    assert.equal(asStore.store, store)
    assert.equal(asStore.hasDatabase, true)
    assert.equal(asStore.databaseBytes, 2048)
    assert.equal(asStore.kbEntries, 3)
    assert.deepEqual(asStore.freshness, { jp: '2026-09-28' })

    const asRoot = classifyPath(root)
    assert.equal(asRoot.ok, true)
    assert.equal(asRoot.kind, 'repo-root')
    assert.equal(asRoot.store, store)
    assert.equal(asRoot.root, root)

    const asKb = classifyPath(join(store, 'kb'))
    assert.equal(asKb.ok, true)
    assert.equal(asKb.kind, 'kb-dir')
    assert.equal(asKb.store, store)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('classifyPath reports a specific reason instead of silently accepting', () => {
  const root = mkdtempSync(join(tmpdir(), 'sks-deploy-'))
  try {
    assert.equal(classifyPath('').reason, 'empty')
    assert.equal(classifyPath('   ').reason, 'empty')
    assert.equal(classifyPath('relative/path').reason, 'not-absolute')
    assert.equal(classifyPath(join(root, 'nope')).reason, 'not-found')

    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')
    assert.equal(classifyPath(file).reason, 'not-a-directory')

    // 现存目录，但既不是 store、也不是仓库根 → 拒绝（避免把库指到必然失败的路径）
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const plainResult = classifyPath(plain)
    assert.equal(plainResult.ok, false)
    assert.equal(plainResult.reason, 'no-store-found')
    assert.match(plainResult.message, /不是 SekaiSync 部署/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('classifyPath accepts a repo root whose store is not built yet, and tolerates quoted input', () => {
  const root = mkdtempSync(join(tmpdir(), 'sks-deploy-'))
  try {
    mkdirSync(join(root, 'sekaisync'), { recursive: true })
    writeFileSync(join(root, 'sekaisync', 'tools.py'), '')
    const result = classifyPath(`"${root}"`)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'repo-root-empty-store')
    assert.equal(result.store, join(root, 'store'))
    assert.equal(result.hasDatabase, false)
    assert.match(result.message, /未找到 kb\/sekaisync\.db/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the removed panel helpers are gone: lib/deploy.js no longer walks the filesystem', async () => {
  // 自动探测与目录枚举只是面板上被删掉的两个按钮的后端。它们必须真正消失，
  // 而不是变成没人调用的死代码继续留在模块导出面上。
  const mod = await import('../lib/deploy.js')
  assert.equal(mod.detectCandidates, undefined, 'detectCandidates must not be exported any more')
  assert.equal(mod.listDirectories, undefined, 'listDirectories must not be exported any more')
  assert.deepEqual(Object.keys(mod).sort(), ['classifyPath', 'formatBytes', 'hasSekaiSyncSource'])
})

test('source-root evidence requires a SekaiSync source file, not a generic project or directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'sks-deploy-'))
  try {
    assert.equal(hasSekaiSyncSource(null), false)
    assert.equal(hasSekaiSyncSource(root), false)
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "unrelated"\n')
    assert.equal(hasSekaiSyncSource(root), false)
    mkdirSync(join(root, 'sekaisync', '__init__.py'), { recursive: true })
    assert.equal(hasSekaiSyncSource(root), false, 'a directory named like a source file is not source evidence')
    writeFileSync(join(root, 'sekaisync', 'tools.py'), '')
    assert.equal(hasSekaiSyncSource(root), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('formatBytes is presentation-only and total', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KiB')
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MiB')
  assert.equal(formatBytes(Number.NaN), '0 B')
  assert.equal(formatBytes(undefined), '0 B')
})
