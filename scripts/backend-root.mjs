import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultPluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function isBackendRoot(candidate) {
  try { return statSync(join(candidate, 'sekaisync', 'cli.py')).isFile() } catch { return false }
}

export function resolveBackendRoot({
  argument, envRoot = process.env.SEKAISYNC_ROOT, pluginRoot = defaultPluginRoot, cwd = process.cwd(),
} = {}) {
  const validateExplicit = (value, source) => {
    const candidate = resolve(cwd, value)
    if (!value.trim() || !isBackendRoot(candidate)) {
      throw new Error(`${source} must point to a backend checkout containing sekaisync/cli.py: ${candidate}`)
    }
    return candidate
  }
  if (argument !== undefined && argument !== null) return validateExplicit(argument, 'backend-root argument')
  if (envRoot !== undefined && envRoot !== '') return validateExplicit(envRoot, 'SEKAISYNC_ROOT')

  let candidate = resolve(pluginRoot)
  while (true) {
    if (isBackendRoot(candidate)) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  for (const name of ['sekaisync-cli', 'sekaisync']) {
    candidate = resolve(pluginRoot, '..', name)
    if (isBackendRoot(candidate)) return candidate
  }
  throw new Error('Backend checkout not found. Pass <backend-root> or set SEKAISYNC_ROOT to a directory containing sekaisync/cli.py.')
}
