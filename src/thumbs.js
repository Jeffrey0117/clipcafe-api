const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const TMP_SUFFIX = '.tmp'
const PRUNE_EVERY_WRITES = 200
const PRUNE_TARGET_RATIO = 0.9
const MAX_REMEMBERED_FAILURES = 5_000

function thumbError(code, message) {
  return Object.assign(new Error(message), { code })
}

function defaultSourceUrl(slug) {
  return `https://clip.cafe/videos/${slug}.mp4`
}

async function exists(file) {
  try {
    await fs.promises.access(file)
    return true
  } catch {
    return false
  }
}

async function removeQuietly(file) {
  try {
    await fs.promises.unlink(file)
  } catch {
    /* 本來就不在 */
  }
}

function prepareDir(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true })
  for (const name of fs.readdirSync(cacheDir)) {
    if (name.endsWith(TMP_SUFFIX)) fs.rmSync(path.join(cacheDir, name), { force: true })
  }
}

// 同時只跑 maxConcurrent 個工作。排隊超過 maxQueue 直接拒絕;
// 排太久(超過 maxWaitMs)的也不跑了 — 要圖的人早就放棄,硬跑只是白燒 ffmpeg 和頻寬。
function createLimiter({ maxConcurrent, maxQueue, maxWaitMs, now }) {
  let active = 0
  const waiting = []

  // 有人在排隊就把名額直接交棒,不先歸還 — 免得中間被插隊而超過上限
  function release() {
    const next = waiting.shift()
    if (next) return next()
    active -= 1
  }

  async function acquire() {
    if (active < maxConcurrent) {
      active += 1
      return
    }
    if (waiting.length >= maxQueue) throw thumbError('busy', 'thumbnail queue is full')
    const queuedAt = now()
    await new Promise((resolve) => waiting.push(resolve))
    if (now() - queuedAt > maxWaitMs) {
      release()
      throw thumbError('busy', 'waited too long in the thumbnail queue')
    }
  }

  async function run(task) {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }

  return { run }
}

// 影片首幀縮圖的磁碟快取。slug 對應的縮圖永遠不變,所以抽一次就一直用。
// 呼叫端必須先驗過 slug 格式(只含 a-z 0-9 -),這裡直接拿它組檔名。
function createThumbStore({
  cacheDir,
  extract,
  sourceUrl = defaultSourceUrl,
  maxConcurrent = 3,
  maxQueue = 12,
  maxWaitMs = 15_000,
  maxFiles = 20_000,
  failureTtlMs = 10 * 60_000,
  now = Date.now,
  onError = (err) => process.stderr.write(`[thumbs] ${err.message}\n`)
}) {
  prepareDir(cacheDir)

  const limiter = createLimiter({ maxConcurrent, maxQueue, maxWaitMs, now })
  const inflight = new Map()
  const failures = new Map()
  let writesSincePrune = 0

  function fileFor(slug) {
    return path.join(cacheDir, `${slug}.jpg`)
  }

  function recentlyFailed(slug) {
    const failedAt = failures.get(slug)
    if (failedAt === undefined) return false
    if (now() - failedAt <= failureTtlMs) return true
    failures.delete(slug)
    return false
  }

  function rememberFailure(slug) {
    if (failures.size >= MAX_REMEMBERED_FAILURES) {
      failures.delete(failures.keys().next().value)
    }
    failures.set(slug, now())
  }

  async function generate(slug) {
    const target = fileFor(slug)
    // 排隊期間可能已經有別的請求把圖做好了
    if (await exists(target)) return target

    const tmp = path.join(cacheDir, `${slug}.${crypto.randomBytes(6).toString('hex')}${TMP_SUFFIX}`)
    try {
      await extract({ url: sourceUrl(slug), outputPath: tmp })
      await fs.promises.rename(tmp, target)
    } catch (err) {
      await removeQuietly(tmp)
      // 改名輸給另一個剛好做完的請求(Windows 上目標檔正在被讀就會失敗)— 圖已經在了,照送
      if (await exists(target)) return target
      rememberFailure(slug)
      onError(new Error(`${slug}: ${err.message}`))
      throw thumbError('failed', 'thumbnail extraction failed')
    }
    schedulePrune()
    return target
  }

  function schedulePrune() {
    writesSincePrune += 1
    if (writesSincePrune < PRUNE_EVERY_WRITES) return
    writesSincePrune = 0
    prune().catch(onError)
  }

  async function prune() {
    const names = (await fs.promises.readdir(cacheDir)).filter((name) => name.endsWith('.jpg'))
    if (names.length <= maxFiles) return 0

    // 檔案可能在列目錄之後被刪掉;單一檔案 stat 失敗就跳過,不要讓整輪清理作廢
    const stats = await Promise.all(
      names.map(async (name) => {
        const file = path.join(cacheDir, name)
        try {
          const { mtimeMs } = await fs.promises.stat(file)
          return { file, mtimeMs }
        } catch {
          return null
        }
      })
    )
    const present = stats.filter((entry) => entry !== null)
    const excess = present.length - Math.floor(maxFiles * PRUNE_TARGET_RATIO)
    if (excess <= 0) return 0
    const oldest = [...present].sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, excess)
    await Promise.all(oldest.map(({ file }) => removeQuietly(file)))
    return oldest.length
  }

  async function get(slug, { generate: allowGenerate = false } = {}) {
    const target = fileFor(slug)
    if (await exists(target)) return target
    if (!allowGenerate) throw thumbError('not_found', 'thumbnail not available')
    if (recentlyFailed(slug)) throw thumbError('failed', 'thumbnail extraction failed recently')

    const pending = inflight.get(slug)
    if (pending) return pending

    const promise = limiter.run(() => generate(slug)).finally(() => inflight.delete(slug))
    inflight.set(slug, promise)
    return promise
  }

  return { get, prune }
}

module.exports = { createThumbStore }
