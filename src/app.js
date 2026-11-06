const express = require('express')
const { normalizeSearch } = require('./normalize')

// clip.cafe's own frontend pages with size=90; its search backend rejects
// deep pagination past ~10k documents (Elasticsearch-style window).
const MAX_SIZE = 90
const MAX_FROM = 10000 - MAX_SIZE
const MAX_SLOP = 10
const SLUG_PATTERN = /^[a-z0-9-]{1,200}$/

function firstString(value) {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : ''
  }
  return typeof value === 'string' ? value : ''
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(firstString(value), 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function parseSearchParams(query) {
  const q = firstString(query.q).trim()
  if (!q) return { error: 'q is required' }
  return {
    params: {
      q,
      from: clamp(toInt(query.from, 0), 0, MAX_FROM),
      size: clamp(toInt(query.size, 30), 1, MAX_SIZE),
      slop: clamp(toInt(query.slop, 0), 0, MAX_SLOP)
    }
  }
}

function upstreamErrorStatus(err) {
  return err.name === 'TimeoutError' || err.name === 'AbortError' ? 504 : 502
}

function createApp({ searchUpstream, cache }) {
  const app = express()
  app.disable('x-powered-by')

  const inflight = new Map()

  function dedupe(key, fn) {
    const existing = inflight.get(key)
    if (existing) return existing
    const promise = fn().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  app.get('/api/search', async (req, res) => {
    const { params, error } = parseSearchParams(req.query)
    if (error) {
      return res.status(400).json({ success: false, error })
    }

    const cacheKey = `${params.q}|${params.from}|${params.size}|${params.slop}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      res.set('Cache-Control', 'public, max-age=300')
      return res.json({ success: true, data: cached })
    }

    try {
      const data = await dedupe(cacheKey, async () => {
        const raw = await searchUpstream(params)
        const normalized = normalizeSearch(raw)
        cache.set(cacheKey, normalized)
        return normalized
      })
      res.set('Cache-Control', 'public, max-age=300')
      return res.json({ success: true, data })
    } catch (err) {
      process.stderr.write(
        `[search] upstream failed q=${JSON.stringify(params.q)}: ${err.message}\n`
      )
      return res
        .status(upstreamErrorStatus(err))
        .json({ success: false, error: 'clip.cafe upstream error' })
    }
  })

  app.get('/api/video/:slug', (req, res) => {
    const { slug } = req.params
    if (!SLUG_PATTERN.test(slug)) {
      return res.status(400).json({ success: false, error: 'invalid slug' })
    }
    return res.redirect(302, `https://clip.cafe/videos/${slug}.mp4`)
  })

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'not found' })
  })

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    process.stderr.write(
      `[unhandled] ${req.method} ${req.originalUrl}: ${err.stack}\n`
    )
    res.status(500).json({ success: false, error: 'internal error' })
  })

  return app
}

module.exports = { createApp }
