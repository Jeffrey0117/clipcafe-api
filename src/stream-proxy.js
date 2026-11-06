const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const RANGE_PATTERN = /^bytes=(\d+-\d*|-\d+)$/
const PASS_STATUS = new Set([200, 206])

function defaultSourceUrl(slug) {
  return `https://clip.cafe/videos/${slug}.mp4`
}

function streamError(code, message) {
  return Object.assign(new Error(message), { code })
}

// 把片源的 mp4 原樣轉送出去(支援 Range,瀏覽器才能拖進度條)。
// 片源網址只存在這一層,外面的人只看得到我們自己的網址。
function createStreamProxy({
  fetchImpl = globalThis.fetch,
  sourceUrl = defaultSourceUrl,
  maxConcurrent = 48,
  connectTimeoutMs = 10_000,
  idleTimeoutMs = 20_000,
  maxDurationMs = 5 * 60_000
} = {}) {
  let active = 0

  // 回 { status, headers, pipeTo(res) };呼叫端負責把 headers 寫出去
  async function open(slug, rangeHeader) {
    if (active >= maxConcurrent) throw streamError('busy', 'too many concurrent streams')
    active += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      active -= 1
    }

    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs)
    const headers = { 'User-Agent': USER_AGENT }
    if (typeof rangeHeader === 'string' && RANGE_PATTERN.test(rangeHeader)) {
      headers.Range = rangeHeader
    }

    let upstream
    try {
      upstream = await fetchImpl(sourceUrl(slug), { headers, signal: controller.signal })
    } catch (err) {
      clearTimeout(connectTimer)
      release()
      throw streamError('failed', `upstream fetch failed: ${err.message}`)
    }
    clearTimeout(connectTimer)

    const fail = async (code, message) => {
      await upstream.body?.cancel().catch(() => {})
      release()
      throw streamError(code, message)
    }
    if (upstream.status === 404) return fail('not_found', 'clip not found upstream')
    if (upstream.status === 416) return fail('range', 'range not satisfiable')
    if (!PASS_STATUS.has(upstream.status)) {
      return fail('failed', `upstream responded with ${upstream.status}`)
    }
    const type = upstream.headers.get('content-type') || ''
    if (!type.startsWith('video/')) return fail('failed', `unexpected content type: ${type}`)

    const out = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' }
    const length = upstream.headers.get('content-length')
    const range = upstream.headers.get('content-range')
    if (length) out['Content-Length'] = length
    if (range) out['Content-Range'] = range

    // 一個名額最多佔 maxDurationMs;位元組超過 idleTimeoutMs 沒在動(對方故意慢慢讀、
    // 或上游卡住)就收掉,免得少數連線把名額全部佔死。瀏覽器之後要繼續看會自己用 Range 重連。
    async function pipeTo(res) {
      const source = Readable.fromWeb(upstream.body)
      // 兩邊都收:上游連線中止,同時把管線本身拆掉(不能只靠上游自己發現被中止)
      const abort = () => {
        controller.abort()
        source.destroy()
      }
      const lifetime = setTimeout(abort, maxDurationMs)
      const idle = setTimeout(abort, idleTimeoutMs)
      source.on('data', () => idle.refresh())
      res.once('close', abort)
      try {
        await pipeline(source, res)
      } catch {
        /* 觀眾關掉分頁、上游斷線或逾時:連線已經收掉,沒有東西可回 */
      } finally {
        clearTimeout(lifetime)
        clearTimeout(idle)
        release()
      }
    }

    // 開了卻沒辦法送(寫標頭就出錯之類):把上游連線和名額都還回去
    function cancel() {
      controller.abort()
      release()
    }

    return { status: upstream.status, headers: out, pipeTo, cancel }
  }

  return { open, activeCount: () => active }
}

module.exports = { createStreamProxy }
