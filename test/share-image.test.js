const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createApp } = require('../src/app')
const { createCache } = require('../src/cache')
const { createFrameExtractor } = require('../src/ffmpeg')

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'phrasefind.json'), 'utf8'))
const KNOWN_SLUG = raw.results[0].slug

// 假的圖庫:記下誰來要圖,真的寫一個小檔讓路由有東西可送
function fakeStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clipcafe-${label}-`))
  const calls = []
  return {
    calls,
    async get(slug, { generate }) {
      calls.push({ slug, generate })
      if (!generate) throw Object.assign(new Error('not_found'), { code: 'not_found' })
      const file = path.join(dir, `${slug}.jpg`)
      fs.writeFileSync(file, label)
      return file
    }
  }
}

function start(options) {
  const app = createApp({ searchUpstream: async () => raw, cache: createCache({ ttlMs: 60000 }), ...options })
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    })
  })
}

test('/api/og/:slug 走分享圖的圖庫,/api/thumb/:slug 走封面的圖庫,兩邊不混用', async () => {
  const thumbs = fakeStore('thumb')
  const shareImages = fakeStore('share')
  const { base, close } = await start({ thumbs, shareImages })
  try {
    await (await fetch(`${base}/api/search?q=hello`)).json()
    const og = await fetch(`${base}/api/og/${KNOWN_SLUG}`)
    assert.equal(og.status, 200)
    assert.equal(og.headers.get('content-type'), 'image/jpeg')
    assert.equal(await og.text(), 'share')
    const thumb = await fetch(`${base}/api/thumb/${KNOWN_SLUG}`)
    assert.equal(await thumb.text(), 'thumb')
    assert.deepEqual(shareImages.calls, [{ slug: KNOWN_SLUG, generate: true }])
    assert.deepEqual(thumbs.calls, [{ slug: KNOWN_SLUG, generate: true }])
  } finally {
    close()
  }
})

test('/api/og/:slug 沒在搜尋結果出現過的片不抽圖 → 404;沒設定圖庫 → 503;slug 不合法 → 400', async () => {
  const shareImages = fakeStore('share')
  const withStore = await start({ shareImages })
  try {
    assert.equal((await fetch(`${withStore.base}/api/og/never-searched-clip`)).status, 404)
    assert.equal((await fetch(`${withStore.base}/api/og/Bad_Slug`)).status, 400)
  } finally {
    withStore.close()
  }
  const without = await start({})
  try {
    assert.equal((await fetch(`${without.base}/api/og/${KNOWN_SLUG}`)).status, 503)
  } finally {
    without.close()
  }
})

test('抽圖器可以指定濾鏡(分享圖用固定 1200x630),沒指定就照寬度等比例縮', async () => {
  const seen = []
  const spawnImpl = (cmd, args) => {
    seen.push(args)
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    fs.writeFileSync(args[args.length - 1], 'jpeg-bytes')
    setImmediate(() => child.emit('close', 0))
    return child
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcafe-filter-'))
  const filter = 'scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630'
  await createFrameExtractor({ ffmpegPath: 'ffmpeg', spawnImpl, filter })({
    url: 'https://clip.cafe/videos/x.mp4',
    outputPath: path.join(dir, 'a.jpg')
  })
  await createFrameExtractor({ ffmpegPath: 'ffmpeg', spawnImpl, width: 480 })({
    url: 'https://clip.cafe/videos/x.mp4',
    outputPath: path.join(dir, 'b.jpg')
  })
  const filterOf = (args) => args[args.indexOf('-vf') + 1]
  assert.equal(filterOf(seen[0]), filter)
  assert.equal(filterOf(seen[1]), 'scale=480:-2')
})
