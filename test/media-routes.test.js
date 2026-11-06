const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createApp } = require('../src/app')
const { createCache } = require('../src/cache')
const { createStreamProxy } = require('../src/stream-proxy')
const { createSubtitleStore } = require('../src/subtitles')
const { createInternalAuth } = require('../src/internal-auth')

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPiece of cake\n'
const KEY = 'k'.repeat(40)

function start(options = {}) {
  const app = createApp({
    searchUpstream: async () => ({ results: [] }),
    cache: createCache({ ttlMs: 60000 }),
    ...options
  })
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    })
  })
}

// 假片源:記下收到的請求,照設定回應
function fakeUpstream(respond) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} })
    return respond(String(url), init)
  }
  return { calls, fetchImpl }
}

function videoResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': 'video/mp4', ...headers } })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('stream: 整支影片原樣轉送,片源網址不外露', async () => {
  const upstream = fakeUpstream(() => videoResponse('mp4-bytes', { headers: { 'content-length': '9' } }))
  const { base, close } = await start({ stream: createStreamProxy({ fetchImpl: upstream.fetchImpl }) })
  try {
    const res = await fetch(`${base}/api/stream/piece-of-cake`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'video/mp4')
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(await res.text(), 'mp4-bytes')
    assert.equal(upstream.calls[0].url, 'https://clip.cafe/videos/piece-of-cake.mp4')
    assert.equal(upstream.calls[0].headers.Range, undefined)
  } finally {
    close()
  }
})

test('stream: Range 請求帶去片源,206 與 Content-Range 帶回來', async () => {
  const upstream = fakeUpstream(() =>
    videoResponse('abcd', { status: 206, headers: { 'content-range': 'bytes 0-3/100', 'content-length': '4' } })
  )
  const { base, close } = await start({ stream: createStreamProxy({ fetchImpl: upstream.fetchImpl }) })
  try {
    const res = await fetch(`${base}/api/stream/piece-of-cake`, { headers: { Range: 'bytes=0-3' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 0-3/100')
    assert.equal(await res.text(), 'abcd')
    assert.equal(upstream.calls[0].headers.Range, 'bytes=0-3')
  } finally {
    close()
  }
})

test('stream: 亂寫的 Range 不會帶去片源', async () => {
  const upstream = fakeUpstream(() => videoResponse('x'))
  const { base, close } = await start({ stream: createStreamProxy({ fetchImpl: upstream.fetchImpl }) })
  try {
    const res = await fetch(`${base}/api/stream/piece-of-cake`, { headers: { Range: 'bytes=0-1,5-9' } })
    assert.equal(res.status, 200)
    await res.text()
    assert.equal(upstream.calls[0].headers.Range, undefined)
  } finally {
    close()
  }
})

test('stream: 片源 404 → 404;片源回非影片 → 502;slug 不合法 → 400', async () => {
  let mode = 'missing'
  const upstream = fakeUpstream(() =>
    mode === 'missing'
      ? new Response('nope', { status: 404 })
      : new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
  )
  const { base, close } = await start({ stream: createStreamProxy({ fetchImpl: upstream.fetchImpl }) })
  try {
    const missing = await fetch(`${base}/api/stream/no-such-clip`)
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('cache-control'), 'no-store')
    mode = 'html'
    assert.equal((await fetch(`${base}/api/stream/no-such-clip`)).status, 502)
    assert.equal((await fetch(`${base}/api/stream/Bad_Slug`)).status, 400)
    assert.equal(upstream.calls.length, 2)
  } finally {
    close()
  }
})

test('stream: 超過同時串流上限 → 503,放掉之後名額回來', async () => {
  let releaseFirst
  const upstream = fakeUpstream(
    () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve(videoResponse('done'))
      })
  )
  const proxy = createStreamProxy({ fetchImpl: upstream.fetchImpl, maxConcurrent: 1 })
  const { base, close } = await start({ stream: proxy })
  try {
    const first = fetch(`${base}/api/stream/one`)
    while (upstream.calls.length === 0) await tick()
    const second = await fetch(`${base}/api/stream/two`)
    assert.equal(second.status, 503)
    assert.equal(second.headers.get('retry-after'), '5')
    releaseFirst()
    assert.equal(await (await first).text(), 'done')
    while (proxy.activeCount() > 0) await tick()
    assert.equal(proxy.activeCount(), 0)
  } finally {
    close()
  }
})

test('stream: 沒設定串流服務 → 503', async () => {
  const { base, close } = await start()
  try {
    assert.equal((await fetch(`${base}/api/stream/piece-of-cake`)).status, 503)
  } finally {
    close()
  }
})

test('subs: 回 WebVTT,同一支片只抓片源一次', async () => {
  const upstream = fakeUpstream(() => new Response(VTT, { status: 200, headers: { 'content-type': 'text/vtt' } }))
  const { base, close } = await start({ subtitles: createSubtitleStore({ fetchImpl: upstream.fetchImpl }) })
  try {
    const res = await fetch(`${base}/api/subs/piece-of-cake/en`)
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').startsWith('text/vtt'))
    assert.equal(await res.text(), VTT)
    await (await fetch(`${base}/api/subs/piece-of-cake/en`)).text()
    assert.equal(upstream.calls.length, 1)
    assert.equal(upstream.calls[0].url, 'https://clip.cafe/vtt/piece-of-cake-en.vtt')
  } finally {
    close()
  }
})

test('subs: 片源回空的 WEBVTT 當成沒字幕;語言格式不對 → 400;片源壞掉 → 502', async () => {
  let mode = 'empty'
  const upstream = fakeUpstream(() =>
    mode === 'empty' ? new Response('WEBVTT\n\n', { status: 200 }) : new Response('boom', { status: 500 })
  )
  const { base, close } = await start({ subtitles: createSubtitleStore({ fetchImpl: upstream.fetchImpl }) })
  try {
    assert.equal((await fetch(`${base}/api/subs/no-such-clip/en`)).status, 404)
    assert.equal((await fetch(`${base}/api/subs/no-such-clip/EN`)).status, 400)
    assert.equal((await fetch(`${base}/api/subs/no-such-clip/english`)).status, 400)
    mode = 'broken'
    assert.equal((await fetch(`${base}/api/subs/other-clip/en`)).status, 502)
  } finally {
    close()
  }
})

test('internal key: 設了金鑰之後,/api 底下沒帶對 Bearer 一律 401', async () => {
  const upstream = fakeUpstream(() => new Response(VTT, { status: 200 }))
  const { base, close } = await start({
    subtitles: createSubtitleStore({ fetchImpl: upstream.fetchImpl }),
    internalAuth: createInternalAuth({ key: KEY })
  })
  try {
    const paths = [
      '/api/search?q=hello',
      '/api/subs/piece-of-cake/en',
      '/api/thumb/piece-of-cake',
      '/api/stream/piece-of-cake',
      '/api/video/piece-of-cake'
    ]
    for (const path of paths) {
      const res = await fetch(base + path, { redirect: 'manual' })
      assert.equal(res.status, 401, path)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    }
    const wrong = await fetch(`${base}/api/search?q=hello`, { headers: { Authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401)
    const ok = await fetch(`${base}/api/search?q=hello`, { headers: { Authorization: `Bearer ${KEY}` } })
    assert.equal(ok.status, 200)
    assert.equal(upstream.calls.length, 0)
  } finally {
    close()
  }
})

test('internal key: 沒設金鑰 = 開發模式,照常放行', async () => {
  const auth = createInternalAuth({ key: '' })
  assert.equal(auth.enabled, false)
  const { base, close } = await start({ internalAuth: auth })
  try {
    assert.equal((await fetch(`${base}/api/search?q=hello`)).status, 200)
  } finally {
    close()
  }
})

test('stream: HEAD 回 405,不會去片源拉整支片', async () => {
  const upstream = fakeUpstream(() => videoResponse('x'))
  const { base, close } = await start({ stream: createStreamProxy({ fetchImpl: upstream.fetchImpl }) })
  try {
    const res = await fetch(`${base}/api/stream/piece-of-cake`, { method: 'HEAD' })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'GET')
    assert.equal(upstream.calls.length, 0)
  } finally {
    close()
  }
})

// 一條永遠送不完的假影片:送一塊之後就不再有資料
function stalledVideo(onCancel) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first-chunk'))
    },
    cancel() {
      onCancel()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } })
}

test('stream: 觀眾中途斷線,名額馬上還回去', async () => {
  let cancelled = false
  const upstream = fakeUpstream(() => stalledVideo(() => { cancelled = true }))
  const proxy = createStreamProxy({ fetchImpl: upstream.fetchImpl, maxConcurrent: 1 })
  const { base, close } = await start({ stream: proxy })
  try {
    const controller = new AbortController()
    const res = await fetch(`${base}/api/stream/piece-of-cake`, { signal: controller.signal })
    await res.body.getReader().read()
    assert.equal(proxy.activeCount(), 1)
    controller.abort()
    while (proxy.activeCount() > 0) await tick()
    assert.equal(proxy.activeCount(), 0)
    assert.equal(cancelled, true)
  } finally {
    close()
  }
})

test('stream: 資料卡住超過閒置時間就收掉,不讓慢速連線佔死名額', async () => {
  const upstream = fakeUpstream(() => stalledVideo(() => {}))
  const proxy = createStreamProxy({ fetchImpl: upstream.fetchImpl, maxConcurrent: 1, idleTimeoutMs: 60 })
  const { base, close } = await start({ stream: proxy })
  try {
    const res = await fetch(`${base}/api/stream/piece-of-cake`)
    await res.arrayBuffer().catch(() => {})
    while (proxy.activeCount() > 0) await tick()
    assert.equal(proxy.activeCount(), 0)
    const next = await fetch(`${base}/api/stream/piece-of-cake`)
    assert.equal(next.status, 200)
    await next.arrayBuffer().catch(() => {})
  } finally {
    close()
  }
})
