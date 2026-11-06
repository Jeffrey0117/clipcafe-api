const { SLUG_PATTERN } = require('./slug-registry')
const { LANG_PATTERN } = require('./subtitles')

const STREAM_ERROR_STATUS = { not_found: 404, busy: 503, range: 416, failed: 502 }
const SUBTITLE_ERROR_STATUS = { not_found: 404, failed: 502 }

function sendError(res, status, message, extra = {}) {
  res.set({ 'Cache-Control': 'no-store', ...extra })
  return res.status(status).json({ success: false, error: message })
}

// 影片串流與字幕。兩者都是把片源的東西包一層再送出去。
function mountMediaRoutes(app, { stream = null, subtitles = null }) {
  app.get('/api/stream/:slug', async (req, res) => {
    const { slug } = req.params
    if (!SLUG_PATTERN.test(slug)) return sendError(res, 400, 'invalid slug')
    if (!stream) return sendError(res, 503, 'streaming unavailable')
    // HEAD 也會走到這裡;不要為了一個 HEAD 去片源拉整支片
    if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', { Allow: 'GET' })

    let opened
    try {
      opened = await stream.open(slug, req.get('Range'))
    } catch (err) {
      const status = STREAM_ERROR_STATUS[err.code]
      if (!status) throw err
      if (status === 502) process.stderr.write(`[stream] slug=${slug}: ${err.message}\n`)
      return sendError(res, status, `stream ${err.code}`, err.code === 'busy' ? { 'Retry-After': '5' } : {})
    }
    try {
      res.status(opened.status).set({ ...opened.headers, 'Cache-Control': 'no-store' })
    } catch (err) {
      opened.cancel()
      throw err
    }
    return opened.pipeTo(res)
  })

  app.get('/api/subs/:slug/:lang', async (req, res) => {
    const { slug, lang } = req.params
    if (!SLUG_PATTERN.test(slug)) return sendError(res, 400, 'invalid slug')
    if (!LANG_PATTERN.test(lang)) return sendError(res, 400, 'invalid language')
    if (!subtitles) return sendError(res, 503, 'subtitles unavailable')

    try {
      const text = await subtitles.get(slug, lang)
      res.set('Cache-Control', 'private, max-age=3600')
      return res.type('text/vtt; charset=utf-8').send(text)
    } catch (err) {
      const status = SUBTITLE_ERROR_STATUS[err.code]
      if (!status) throw err
      if (status === 502) process.stderr.write(`[subs] slug=${slug} lang=${lang}: ${err.message}\n`)
      return sendError(res, status, `subtitles ${err.code}`)
    }
  })
}

module.exports = { mountMediaRoutes }
