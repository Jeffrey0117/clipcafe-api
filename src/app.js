const express = require('express')
const path = require('node:path')
const { normalizeSearch } = require('./normalize')
const { createSlugRegistry, SLUG_PATTERN } = require('./slug-registry')
const { mountMediaRoutes } = require('./media-routes')

// clip.cafe's own frontend pages with size=90; its search backend rejects
// deep pagination past ~10k documents (Elasticsearch-style window).
const MAX_SIZE = 90
const MAX_FROM = 10000 - MAX_SIZE
const MAX_SLOP = 10
const THUMB_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
const THUMB_ERROR_STATUS = { not_found: 404, busy: 503, failed: 502 }

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

function createApp({
  searchUpstream,
  cache,
  thumbs = null,
  stream = null,
  subtitles = null,
  internalAuth = null
}) {
  const app = express()
  app.disable('x-powered-by')
  if (internalAuth) app.use('/api', internalAuth.middleware)

  const inflight = new Map()
  const knownSlugs = createSlugRegistry()

  function rememberSlugs(data) {
    for (const clip of data.results) knownSlugs.add(clip.slug)
    return data
  }

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
      rememberSlugs(cached)
      res.set('Cache-Control', 'public, max-age=300')
      return res.json({ success: true, data: cached })
    }

    try {
      const data = await dedupe(cacheKey, async () => {
        const raw = await searchUpstream(params)
        const normalized = normalizeSearch(raw)
        cache.set(cacheKey, normalized)
        return rememberSlugs(normalized)
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

  // 影片首幀縮圖。只替搜尋結果出現過的 slug 抽圖;已經抽好的照送。
  app.get('/api/thumb/:slug', async (req, res) => {
    const { slug } = req.params
    if (!SLUG_PATTERN.test(slug)) {
      return res.status(400).json({ success: false, error: 'invalid slug' })
    }
    if (!thumbs) {
      res.set('Cache-Control', 'no-store')
      return res.status(503).json({ success: false, error: 'thumbnails unavailable' })
    }

    let file
    try {
      file = await thumbs.get(slug, { generate: knownSlugs.has(slug) })
    } catch (err) {
      const status = THUMB_ERROR_STATUS[err.code]
      if (!status) throw err
      res.set('Cache-Control', 'no-store')
      if (err.code === 'busy') res.set('Retry-After', '5')
      return res.status(status).json({ success: false, error: `thumbnail ${err.code}` })
    }

    // 長快取標頭交給 sendFile 在「真的送出檔案」時才加;
    // 檔案剛好被清掉或讀不到時,回的是不快取的 JSON,不會被當成圖片快取一年
    const options = {
      root: path.dirname(file),
      dotfiles: 'allow',
      maxAge: THUMB_MAX_AGE_SECONDS * 1000,
      immutable: true
    }
    return res.sendFile(path.basename(file), options, (err) => {
      if (!err || res.headersSent) return
      const status = err.status === 404 ? 404 : 500
      if (status === 500) {
        process.stderr.write(`[thumb] sendFile failed slug=${slug}: ${err.message}\n`)
      }
      res.set('Cache-Control', 'no-store')
      res.status(status).json({ success: false, error: 'thumbnail not available' })
    })
  })

  mountMediaRoutes(app, { stream, subtitles })

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'not found' })
  })

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    process.stderr.write(
      `[unhandled] ${req.method} ${req.originalUrl}: ${err.stack}\n`
    )
    if (res.headersSent) return
    // 路由可能已經先設了圖片/長快取標頭,錯誤回應不能沿用
    res.removeHeader('Content-Type')
    res.set('Cache-Control', 'no-store')
    res.status(500).json({ success: false, error: 'internal error' })
  })

  return app
}

module.exports = { createApp }
