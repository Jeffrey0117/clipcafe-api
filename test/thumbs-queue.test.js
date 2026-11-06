const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createThumbStore } = require('../src/thumbs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clipcafe-queue-'))
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

function gatedExtract(gate) {
  const calls = []
  const extract = async ({ url, outputPath }) => {
    calls.push(url)
    if (calls.length === 1) await gate.promise
    fs.writeFileSync(outputPath, 'jpeg-bytes')
  }
  return { extract, calls }
}

test('a job that waited in the queue longer than maxWaitMs is dropped instead of run', async () => {
  const gate = deferred()
  const { extract, calls } = gatedExtract(gate)
  let clock = 1_000_000
  const store = createThumbStore({
    cacheDir: tempDir(),
    extract,
    maxConcurrent: 1,
    maxWaitMs: 10_000,
    now: () => clock
  })

  const running = store.get('clip-a', { generate: true })
  await waitFor(() => calls.length === 1)
  const stale = store.get('clip-b', { generate: true })
  const staleOutcome = stale.then(
    () => 'ran',
    (err) => err.code
  )
  await new Promise((r) => setTimeout(r, 30))

  clock += 11_000
  gate.resolve()

  await running
  assert.equal(await staleOutcome, 'busy')
  assert.equal(calls.length, 1)
})

test('dropping a stale job hands the slot on to the next one in line', async () => {
  const gate = deferred()
  const { extract, calls } = gatedExtract(gate)
  let clock = 1_000_000
  const store = createThumbStore({
    cacheDir: tempDir(),
    extract,
    maxConcurrent: 1,
    maxWaitMs: 10_000,
    now: () => clock
  })

  const running = store.get('clip-a', { generate: true })
  await waitFor(() => calls.length === 1)
  const stale = store.get('clip-b', { generate: true }).catch((err) => err.code)
  await new Promise((r) => setTimeout(r, 30))
  clock += 11_000
  const fresh = store.get('clip-c', { generate: true })
  await new Promise((r) => setTimeout(r, 30))

  gate.resolve()
  await running
  assert.equal(await stale, 'busy')
  assert.ok(await fresh)

  const later = await store.get('clip-d', { generate: true })
  assert.ok(later, 'the limiter must not leak a slot')
})

test('a file that appears while the job waits in the queue is served without extracting again', async () => {
  const cacheDir = tempDir()
  const gate = deferred()
  const { extract, calls } = gatedExtract(gate)
  const store = createThumbStore({ cacheDir, extract, maxConcurrent: 1 })

  const running = store.get('clip-a', { generate: true })
  await waitFor(() => calls.length === 1)
  const queued = store.get('clip-b', { generate: true })
  await new Promise((r) => setTimeout(r, 30))
  fs.writeFileSync(path.join(cacheDir, 'clip-b.jpg'), 'made-by-someone-else')

  gate.resolve()
  await running
  const file = await queued

  assert.equal(fs.readFileSync(file, 'utf8'), 'made-by-someone-else')
  assert.equal(calls.length, 1)
})

test('when the rename loses to an existing thumbnail the existing file is served', async () => {
  const cacheDir = tempDir()
  const extract = async ({ outputPath }) => {
    // 模擬另一個請求搶先完成:目標已是個資料夾,rename 一定失敗
    fs.mkdirSync(path.join(cacheDir, 'clip-x.jpg'))
    fs.writeFileSync(outputPath, 'jpeg-bytes')
  }
  const errors = []
  const store = createThumbStore({ cacheDir, extract, onError: (err) => errors.push(err) })

  const file = await store.get('clip-x', { generate: true })
  assert.equal(file, path.join(cacheDir, 'clip-x.jpg'))
  assert.deepEqual(
    fs.readdirSync(cacheDir).filter((name) => name.endsWith('.tmp')),
    []
  )
})

test('prune survives a file disappearing between listing and stat', async () => {
  const cacheDir = tempDir()
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) {
    fs.writeFileSync(path.join(cacheDir, name), 'x')
  }
  const realStat = fs.promises.stat
  fs.promises.stat = async (file, ...rest) => {
    if (path.basename(file) === 'b.jpg') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return realStat(file, ...rest)
  }
  try {
    const store = createThumbStore({ cacheDir, extract: async () => {}, maxFiles: 2 })
    const removed = await store.prune()
    assert.ok(removed >= 1)
  } finally {
    fs.promises.stat = realStat
  }
})
