const path = require('node:path')
const { loadEnv } = require('./src/env')

loadEnv(__dirname)

const { createApp } = require('./src/app')
const { createCache } = require('./src/cache')
const { searchClipCafe } = require('./src/clipcafe')
const { findFfmpeg, createFrameExtractor } = require('./src/ffmpeg')
const { createThumbStore } = require('./src/thumbs')
const { createStreamProxy } = require('./src/stream-proxy')
const { createSubtitleStore } = require('./src/subtitles')
const { createInternalAuth } = require('./src/internal-auth')

function intFromEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  }
  return parsed
}

const PORT = intFromEnv('PORT', 3100)
const CACHE_TTL_MS = intFromEnv('CACHE_TTL_MS', 30 * 60 * 1000)

// 沒有 ffmpeg 就不提供縮圖(/api/thumb 回 503),搜尋照常
function createThumbs() {
  const ffmpegPath = findFfmpeg()
  if (!ffmpegPath) {
    process.stderr.write('ffmpeg not found (FFMPEG_PATH / PATH / winget): thumbnails disabled\n')
    return null
  }
  const cacheDir = process.env.THUMB_CACHE_DIR || path.join(__dirname, 'cache', 'thumbs')
  process.stdout.write(`thumbnails: ffmpeg at ${ffmpegPath}, cache in ${cacheDir}\n`)
  return createThumbStore({
    cacheDir,
    extract: createFrameExtractor({
      ffmpegPath,
      width: intFromEnv('THUMB_WIDTH', 480),
      timeoutMs: intFromEnv('THUMB_TIMEOUT_MS', 20000)
    }),
    maxConcurrent: intFromEnv('THUMB_MAX_CONCURRENT', 3),
    maxFiles: intFromEnv('THUMB_MAX_FILES', 20000)
  })
}

const internalAuth = createInternalAuth({ key: process.env.INTERNAL_API_KEY })
if (!internalAuth.enabled) {
  // 正式環境沒金鑰 = 任何人都能繞過主站直接拿片源,寧可不啟動
  if (process.env.NODE_ENV === 'production') {
    process.stderr.write('INTERNAL_API_KEY is required in production; refusing to start\n')
    process.exit(1)
  }
  process.stderr.write('INTERNAL_API_KEY not set: every caller is trusted (local development only)\n')
}

const app = createApp({
  searchUpstream: searchClipCafe,
  cache: createCache({ ttlMs: CACHE_TTL_MS }),
  thumbs: createThumbs(),
  stream: createStreamProxy({ maxConcurrent: intFromEnv('STREAM_MAX_CONCURRENT', 48) }),
  subtitles: createSubtitleStore(),
  internalAuth
})

const server = app.listen(PORT, () => {
  process.stdout.write(`clipcafe-api listening on http://localhost:${PORT}\n`)
})

server.on('error', (err) => {
  process.stderr.write(`failed to listen on port ${PORT}: ${err.message}\n`)
  process.exit(1)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
