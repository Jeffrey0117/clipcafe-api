const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const LANG_PATTERN = /^[a-z]{2,3}$/

function defaultSourceUrl(slug, lang) {
  return `https://clip.cafe/vtt/${slug}-${lang}.vtt`
}

function subtitleError(code, message) {
  return Object.assign(new Error(message), { code })
}

// 片源的 WebVTT 字幕。檔案很小(通常不到 2KB),放記憶體快取就好。
// 片源對不存在的片也回 200 + 空的 WEBVTT,所以「沒有任何一句」一律當沒字幕。
function createSubtitleStore({
  fetchImpl = globalThis.fetch,
  sourceUrl = defaultSourceUrl,
  maxEntries = 2000,
  ttlMs = 24 * 60 * 60_000,
  maxBytes = 512 * 1024,
  timeoutMs = 8000,
  now = Date.now
} = {}) {
  const cache = new Map()
  const inflight = new Map()

  function remember(key, entry) {
    cache.delete(key)
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value)
    cache.set(key, entry)
  }

  async function load(slug, lang) {
    let res
    try {
      res = await fetchImpl(sourceUrl(slug, lang), {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      throw subtitleError('failed', `subtitle fetch failed: ${err.message}`)
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw subtitleError('failed', `subtitle upstream responded with ${res.status}`)
    }
    const declared = Number.parseInt(res.headers.get('content-length') || '', 10)
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw subtitleError('failed', 'subtitle file is too large')
    }
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) throw subtitleError('failed', 'subtitle file is too large')
    if (!text.startsWith('WEBVTT') || !text.includes('-->')) return null
    return text
  }

  // 回 VTT 字串;沒有字幕丟 code=not_found,抓不到丟 code=failed
  async function get(slug, lang) {
    if (!LANG_PATTERN.test(lang)) throw subtitleError('not_found', 'unsupported language')
    const key = `${slug}|${lang}`
    const hit = cache.get(key)
    if (hit && now() - hit.at <= ttlMs) {
      if (hit.text === null) throw subtitleError('not_found', 'no subtitles for this clip')
      return hit.text
    }

    let pending = inflight.get(key)
    if (!pending) {
      pending = load(slug, lang)
        .then((text) => {
          remember(key, { text, at: now() })
          return text
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    const text = await pending
    if (text === null) throw subtitleError('not_found', 'no subtitles for this clip')
    return text
  }

  return { get }
}

module.exports = { createSubtitleStore, LANG_PATTERN }
