const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { normalizeSearch } = require('../src/normalize')

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'phrasefind.json'), 'utf8')
)

test('normalizeSearch keeps query, paging and total', () => {
  const out = normalizeSearch(raw)
  assert.equal(out.query, 'get a life')
  assert.equal(out.total, 10780)
  assert.equal(out.from, 0)
  assert.equal(out.size, 30)
  assert.equal(out.slop, 0)
})

test('normalizeSearch maps each clip to flat fields with urls', () => {
  const out = normalizeSearch(raw)
  assert.equal(out.results.length, 30)
  const first = out.results[0]
  assert.deepEqual(first, {
    slug: 'you-said-get-a-life',
    text: '- You said, "get a life."',
    mp4: 'https://clip.cafe/videos/you-said-get-a-life.mp4',
    hls: 'https://clip.cafe/hls/tt0115167/you-said-get-a-life/master.m3u8',
    movieTitle: 'Everybody Loves Raymond',
    movieYear: 1996,
    movieSlug: 'everybody-loves-raymond-1996',
    imdb: 'tt0115167',
    season: 5,
    episode: 22,
    duration: 5,
    quality: 'HD',
    subLangs: ['en']
  })
})

test('normalizeSearch passes through related and didYouMean', () => {
  const out = normalizeSearch(raw)
  assert.ok(Array.isArray(out.related))
  assert.ok(out.related.includes('Get a life!'))
  assert.deepEqual(out.didYouMean, [])
})

test('normalizeSearch tolerates missing results', () => {
  const out = normalizeSearch({ query: 'x', total: 0 })
  assert.deepEqual(out.results, [])
  assert.equal(out.total, 0)
})
