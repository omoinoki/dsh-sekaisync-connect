// Internal resource limits; no public tool or REST contract changes.
import { execFile } from 'node:child_process'

export class ByteLru {
  constructor({ maxEntries = 512, maxBytes = 16 * 1024 * 1024, maxEntryBytes = 1024 * 1024 } = {}) {
    this.entries = new Map()
    this.bytes = 0
    Object.assign(this, { maxEntries, maxBytes, maxEntryBytes })
  }
  delete(key) {
    const entry = this.entries.get(key)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key) }
  }
  clear() { this.entries.clear(); this.bytes = 0 }
  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (Date.now() >= entry.expires) { this.delete(key); return undefined }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }
  set(key, value, ttlMs, bytes) {
    this.delete(key)
    // Budget UTF-16 storage too. Object overhead is not an exact heap measure;
    // entry and byte ceilings jointly bound retained response payloads.
    const cost = bytes * 2 + Buffer.byteLength(key, 'utf8') * 2
    if (!Number.isFinite(cost) || cost > this.maxEntryBytes || cost > this.maxBytes) return
    const now = Date.now()
    for (const [k, entry] of this.entries) if (entry.expires <= now) this.delete(k)
    while (this.entries.size >= this.maxEntries || this.bytes + cost > this.maxBytes) {
      this.delete(this.entries.keys().next().value)
    }
    this.entries.set(key, { value, bytes: cost, expires: now + ttlMs })
    this.bytes += cost
  }
}

export function deadlineSignal(callerSignal, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
  const onAbort = () => ctrl.abort(callerSignal.reason)
  if (callerSignal?.aborted) onAbort()
  else callerSignal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: ctrl.signal,
    cleanup() { clearTimeout(timer); callerSignal?.removeEventListener('abort', onAbort) },
  }
}

export function waitWithSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

// Duplicate readers share work, but each caller owns its cancellation/deadline.
// The upstream fetch stops only when the last reader leaves.
export class RequestPool {
  constructor(maxEntries = 64) { this.entries = new Map(); this.maxEntries = maxEntries }
  run(key, start, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= this.maxEntries) return Promise.reject(new Error('请求队列已满，请稍后重试'))
      entry = { ctrl: new AbortController(), users: 0, done: false }
      this.entries.set(key, entry)
      entry.promise = Promise.resolve().then(() => start(entry.ctrl.signal)).finally(() => {
        entry.done = true
        if (this.entries.get(key) === entry) this.entries.delete(key)
      })
    }
    entry.users++
    return waitWithSignal(entry.promise, signal).finally(() => {
      if (--entry.users === 0 && !entry.done) {
        entry.ctrl.abort(new DOMException('No active readers', 'AbortError'))
        if (this.entries.get(key) === entry) this.entries.delete(key)
      }
    })
  }
  clear() {
    for (const entry of this.entries.values()) entry.ctrl.abort(new DOMException('Disposed', 'AbortError'))
    this.entries.clear()
  }
}

export async function readBoundedText(response, maxBytes, { truncate = false } = {}) {
  const declared = Number(response.headers.get('content-length'))
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`HTTP 响应超过 ${maxBytes} 字节预算`)
  }
  if (!response.body) return { text: '', bytes: 0 }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (bytes + value.byteLength > maxBytes) {
        if (!truncate) throw new Error(`HTTP 响应超过 ${maxBytes} 字节预算`)
        chunks.push(value.subarray(0, maxBytes - bytes))
        bytes = maxBytes
        break
      }
      chunks.push(value)
      bytes += value.byteLength
    }
    return { text: Buffer.concat(chunks, bytes).toString('utf8'), bytes }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function runCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message.slice(0, 200)} ${String(stderr || '').slice(-300)}`))
      else resolve({ stdout, stderr })
    })
  })
}

// Stop after the displayed excerpt, rather than normalizing whole novels just
// to discard everything after 1,200 characters.
export function compactExcerpt(value, limit) {
  const text = String(value || '')
  let result = ''
  let space = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (/\s/.test(char)) { if (result) space = true; continue }
    if (space) {
      if (result.length === limit) return { text: result, truncated: true }
      result += ' '
      space = false
    }
    if (result.length === limit) return { text: result, truncated: true }
    result += char
  }
  return { text: result, truncated: false }
}
