const BASE_URL = 'https://clip.cafe/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 8000

function upstreamTimeoutMs() {
  const parsed = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

function buildSearchUrl({ q, from, size, slop }) {
  const encoded = encodeURIComponent(q)
  return `${BASE_URL}?phrasefind=${encoded}&from=${from}&size=${size}&slop=${slop}`
}

async function searchClipCafe(params, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(buildSearchUrl(params), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(upstreamTimeoutMs())
  })
  if (!res.ok) {
    const err = new Error(`clip.cafe responded with ${res.status}`)
    err.status = res.status
    throw err
  }
  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('json')) {
    throw new Error(`clip.cafe returned non-JSON response (${contentType})`)
  }
  return res.json()
}

module.exports = { buildSearchUrl, searchClipCafe }
