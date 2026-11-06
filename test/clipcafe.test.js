const { test } = require('node:test')
const assert = require('node:assert/strict')

const { buildSearchUrl, searchClipCafe } = require('../src/clipcafe')

function fakeResponse({ ok = true, status = 200, contentType = 'application/json', body = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body
  }
}

test('buildSearchUrl encodes query and includes paging params', () => {
  const url = buildSearchUrl({ q: 'get a life', from: 30, size: 90, slop: 2 })
  assert.equal(
    url,
    'https://clip.cafe/?phrasefind=get%20a%20life&from=30&size=90&slop=2'
  )
})

test('buildSearchUrl encodes special characters', () => {
  const url = buildSearchUrl({ q: 'what&why=?', from: 0, size: 30, slop: 0 })
  assert.equal(
    url,
    'https://clip.cafe/?phrasefind=what%26why%3D%3F&from=0&size=30&slop=0'
  )
})

test('searchClipCafe returns parsed JSON and sends UA + abort signal', async () => {
  const seen = []
  const fetchImpl = async (url, options) => {
    seen.push({ url, options })
    return fakeResponse({ body: { query: 'hi', results: [] } })
  }
  const data = await searchClipCafe(
    { q: 'hi', from: 0, size: 30, slop: 0 },
    fetchImpl
  )
  assert.deepEqual(data, { query: 'hi', results: [] })
  assert.match(seen[0].options.headers['User-Agent'], /Mozilla/)
  assert.ok(seen[0].options.signal instanceof AbortSignal)
})

test('searchClipCafe throws with status on non-ok response', async () => {
  const fetchImpl = async () => fakeResponse({ ok: false, status: 429 })
  await assert.rejects(
    searchClipCafe({ q: 'hi', from: 0, size: 30, slop: 0 }, fetchImpl),
    (err) => err.status === 429
  )
})

test('searchClipCafe throws on non-JSON content type', async () => {
  const fetchImpl = async () => fakeResponse({ contentType: 'text/html' })
  await assert.rejects(
    searchClipCafe({ q: 'hi', from: 0, size: 30, slop: 0 }, fetchImpl),
    /non-JSON/
  )
})
