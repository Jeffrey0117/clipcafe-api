const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createThumbStore } = require('../src/thumbs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clipcafe-thumbs-'))
}

function fakeExtract({ fail = () => false, gate } = {}) {
  const calls = []
  const extract = async ({ url, outputPath }) => {
    calls.push({ url, outputPath })
    if (gate) await gate.promise
    if (fail(url)) throw new Error('ffmpeg exploded')
    fs.writeFileSync(outputPath, 'jpeg-bytes')
  }
  return { extract, calls }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function waitFor(condition) {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(condition(), 'condition was not met in time')
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code)
    return true
  })
}

test('generates a thumbnail once and serves the cached file afterwards', async () => {
  const cacheDir = tempDir()
  const { extract, calls } = fakeExtract()
  const store = createThumbStore({ cacheDir, extract })

  const first = await store.get('some-clip', { generate: true })
  const second = await store.get('some-clip', { generate: true })

  assert.equal(first, path.join(cacheDir, 'some-clip.jpg'))
  assert.equal(second, first)
  assert.equal(fs.readFileSync(first, 'utf8'), 'jpeg-bytes')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://clip.cafe/videos/some-clip.mp4')
})

test('concurrent requests for the same slug share one extraction', async () => {
  const gate = deferred()
  const { extract, calls } = fakeExtract({ gate })
  const store = createThumbStore({ cacheDir: tempDir(), extract })

  const pending = [
    store.get('same-clip', { generate: true }),
    store.get('same-clip', { generate: true })
  ]
  gate.resolve()
  const [a, b] = await Promise.all(pending)

  assert.equal(a, b)
  assert.equal(calls.length, 1)
})

test('refuses to generate when the caller does not allow it', async () => {
  const { extract, calls } = fakeExtract()
  const store = createThumbStore({ cacheDir: tempDir(), extract })

  await rejectsWithCode(store.get('unknown-clip', { generate: false }), 'not_found')
  assert.equal(calls.length, 0)
})

test('serves an already cached file even when generation is not allowed', async () => {
  const cacheDir = tempDir()
  const { extract } = fakeExtract()
  const store = createThumbStore({ cacheDir, extract })

  await store.get('cached-clip', { generate: true })
  const file = await store.get('cached-clip', { generate: false })
  assert.equal(file, path.join(cacheDir, 'cached-clip.jpg'))
})

test('a failed extraction is remembered, then retried after the failure TTL', async () => {
  let clock = 1_000_000
  let broken = true
  const { extract, calls } = fakeExtract({ fail: () => broken })
  const store = createThumbStore({
    cacheDir: tempDir(),
    extract,
    failureTtlMs: 60_000,
    now: () => clock
  })

  await rejectsWithCode(store.get('bad-clip', { generate: true }), 'failed')
  await rejectsWithCode(store.get('bad-clip', { generate: true }), 'failed')
  assert.equal(calls.length, 1)

  clock += 61_000
  broken = false
  assert.ok(await store.get('bad-clip', { generate: true }))
  assert.equal(calls.length, 2)
})

test('a failed extraction leaves nothing behind in the cache dir', async () => {
  const cacheDir = tempDir()
  const extract = async ({ outputPath }) => {
    fs.writeFileSync(outputPath, 'partial')
    throw new Error('died halfway')
  }
  const store = createThumbStore({ cacheDir, extract })

  await rejectsWithCode(store.get('half-clip', { generate: true }), 'failed')
  assert.deepEqual(fs.readdirSync(cacheDir), [])
})

test('rejects with busy when the queue is full instead of piling up work', async () => {
  const gate = deferred()
  const { extract, calls } = fakeExtract({ gate })
  const store = createThumbStore({
    cacheDir: tempDir(),
    extract,
    maxConcurrent: 1,
    maxQueue: 1
  })

  const running = store.get('clip-a', { generate: true })
  await waitFor(() => calls.length === 1)
  const queued = store.get('clip-b', { generate: true })
  await new Promise((r) => setTimeout(r, 30))
  await rejectsWithCode(store.get('clip-c', { generate: true }), 'busy')

  gate.resolve()
  await Promise.all([running, queued])
  assert.equal(calls.length, 2)
})

test('never runs more extractions at once than maxConcurrent', async () => {
  let active = 0
  let peak = 0
  const extract = async ({ outputPath }) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(outputPath, 'x')
    active -= 1
  }
  const store = createThumbStore({ cacheDir: tempDir(), extract, maxConcurrent: 2 })

  await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map((slug) => store.get(`clip-${slug}`, { generate: true }))
  )
  assert.equal(peak, 2)
})

test('prune removes the oldest files once the cache exceeds maxFiles', async () => {
  const cacheDir = tempDir()
  const { extract } = fakeExtract()
  const store = createThumbStore({ cacheDir, extract, maxFiles: 4 })

  const slugs = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
  for (const [i, slug] of slugs.entries()) {
    const file = await store.get(slug, { generate: true })
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, i))
    fs.utimesSync(file, stamp, stamp)
  }

  const removed = await store.prune()
  const left = fs.readdirSync(cacheDir).sort()

  assert.ok(removed >= 2)
  assert.ok(left.length <= 4)
  assert.ok(!left.includes('c1.jpg'))
  assert.ok(left.includes('c6.jpg'))
})

test('creates the cache dir and clears leftover temp files on startup', async () => {
  const cacheDir = path.join(tempDir(), 'nested', 'thumbs')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'dead-clip.abc123.tmp'), 'partial')
  fs.writeFileSync(path.join(cacheDir, 'kept-clip.jpg'), 'ok')
  const { extract } = fakeExtract()

  createThumbStore({ cacheDir, extract })
  assert.deepEqual(fs.readdirSync(cacheDir), ['kept-clip.jpg'])

  const fresh = path.join(tempDir(), 'does', 'not', 'exist')
  createThumbStore({ cacheDir: fresh, extract })
  assert.ok(fs.existsSync(fresh))
})
