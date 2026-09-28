// lib/deploy.js 的单元测试：路径分类、候选探测、配置分层与原子写入。
// 全部离线（不联网、不起 sekaisync 子进程），只碰临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { classifyPath, detectCandidates, inspectDeployment, writeLocalConfig, formatBytes } from '../lib/deploy.js'

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

test('detectCandidates finds deployments under an env var and a scanned projects root', () => {
  const base = mkdtempSync(join(tmpdir(), 'sks-detect-'))
  try {
    const envStore = makeStore(join(base, 'from-env'))
    const scanRoot = join(base, 'dsh_projects')
    const scanned = makeStore(join(scanRoot, 'sekaisync-handoff'))
    // 无数据库的那份应排在后面
    makeStore(join(scanRoot, 'sekaisync-empty'), { withDb: false })

    const candidates = detectCandidates({
      pluginRoot: join(base, 'plugin'),
      cwd: join(base, 'elsewhere'),
      env: { SEKAISYNC_STORE: envStore },
    })
    const paths = candidates.map((c) => c.path)
    assert.ok(paths.includes(envStore), 'env store should be a candidate')
    assert.ok(paths.includes(scanned), 'scanned store should be a candidate')

    const withDb = candidates.filter((c) => c.hasDatabase)
    assert.ok(withDb.every((c, i) => i === 0 || withDb[i - 1].databaseBytes >= c.databaseBytes), 'larger DBs sort first')
    assert.equal(candidates.length, new Set(paths).size, 'candidates are de-duplicated')
    assert.ok(candidates.every((c) => existsSync(join(c.path, 'kb'))))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('detectCandidates stays bounded and never throws on unreadable guesses', () => {
  const base = mkdtempSync(join(tmpdir(), 'sks-detect-'))
  try {
    const candidates = detectCandidates({
      pluginRoot: join(base, 'plugin'),
      cwd: join(base, 'missing'),
      env: { SEKAISYNC_STORE: join(base, 'also-missing') },
    })
    assert.ok(Array.isArray(candidates))
    assert.ok(candidates.length <= 12, 'result is capped')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('inspectDeployment reports the winning layer and flags shadowing', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-inspect-'))
  try {
    writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))

    // 1) 只有随包默认值 → 来源是 default
    let state = inspectDeployment({ pluginRoot, env: {}, runtime: null, effective: { store: null } })
    assert.equal(state.fields.store.source, 'default')
    assert.equal(state.fields.store.shadowedBy, null)

    // 2) config.local.json 生效 → 来源 local-file，且不算被遮蔽
    writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store: 'C:\\local', root: 'C:\\local' }))
    state = inspectDeployment({ pluginRoot, env: {}, runtime: null, effective: { store: 'C:\\local' } })
    assert.equal(state.fields.store.source, 'local-file')
    assert.equal(state.fields.store.shadowedBy, null)
    assert.equal(state.writable.store, true)

    // 3) profile 行 config 更高 → 遮蔽本机文件（面板必须如实提示「保存了也不生效」）
    state = inspectDeployment({ pluginRoot, env: {}, runtime: { store: 'C:\\profile' }, effective: { store: 'C:\\profile' } })
    assert.equal(state.fields.store.source, 'profile-row')
    assert.equal(state.fields.store.shadowedBy, 'profile-row')
    assert.equal(state.writable.store, false)

    // 4) 环境变量最高
    state = inspectDeployment({ pluginRoot, env: { SEKAISYNC_STORE: 'C:\\env' }, runtime: { store: 'C:\\profile' }, effective: { store: 'C:\\env' } })
    assert.equal(state.fields.store.source, 'env')
    assert.equal(state.fields.store.detail, 'SEKAISYNC_STORE')
  } finally { rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('writeLocalConfig preserves unrelated keys and is atomic', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-write-'))
  try {
    writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store: 'old', python: 'python3', externalPort: 9000 }))
    const next = writeLocalConfig(pluginRoot, { store: 'new-store', root: 'new-root' })
    assert.equal(next.store, 'new-store')
    assert.equal(next.root, 'new-root')
    assert.equal(next.python, 'python3', 'unrelated keys survive')
    assert.equal(next.externalPort, 9000, 'unrelated keys survive')

    const onDisk = JSON.parse(readFileSync(join(pluginRoot, 'config.local.json'), 'utf8'))
    assert.deepEqual(onDisk, next)
    // 没有留下临时文件
    const leftovers = existsSync(join(pluginRoot, 'config.local.json')) &&
      readFileSync(join(pluginRoot, 'config.local.json'), 'utf8').includes('.tmp')
    assert.equal(leftovers, false)
  } finally { rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('writeLocalConfig refuses fields outside store/root and refuses to clobber broken JSON', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-write-'))
  try {
    // python 是可执行文件路径：面板不得改写（否则等于把任意程序执行暴露给网页）
    assert.throws(() => writeLocalConfig(pluginRoot, { python: 'evil.exe' }), /不允许写入字段/)
    assert.throws(() => writeLocalConfig(pluginRoot, { externalPort: 1 }), /不允许写入字段/)

    writeFileSync(join(pluginRoot, 'config.local.json'), '{ this is not json')
    assert.throws(() => writeLocalConfig(pluginRoot, { store: 'x' }), /解析失败，拒绝覆盖/)
    // 坏文件被原样保留，便于人工修复
    assert.equal(readFileSync(join(pluginRoot, 'config.local.json'), 'utf8'), '{ this is not json')
  } finally { rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('writeLocalConfig removes a field when given null/empty', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-write-'))
  try {
    writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store: 'a', root: 'b' }))
    const next = writeLocalConfig(pluginRoot, { root: null })
    assert.equal(next.root, undefined)
    assert.equal(next.store, 'a')
  } finally { rmSync(pluginRoot, { recursive: true, force: true }) }
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
