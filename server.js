const { loadEnv } = require('./src/env')

loadEnv(__dirname)

const { createApp } = require('./src/app')
const { createCache } = require('./src/cache')
const { searchClipCafe } = require('./src/clipcafe')

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

const app = createApp({
  searchUpstream: searchClipCafe,
  cache: createCache({ ttlMs: CACHE_TTL_MS })
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
