const SLUG_PATTERN = /^[a-z0-9-]{1,200}$/

function isSlug(value) {
  return typeof value === 'string' && SLUG_PATTERN.test(value)
}

// 記住「搜尋結果裡出現過的 slug」。縮圖端點只替這些 slug 開 ffmpeg,
// 亂猜 slug 的請求碰不到抽圖,也打不出對 clip.cafe 的請求。
function createSlugRegistry({ max = 50_000 } = {}) {
  const slugs = new Set()

  function add(slug) {
    if (!isSlug(slug)) return
    slugs.delete(slug)
    slugs.add(slug)
    if (slugs.size > max) {
      slugs.delete(slugs.values().next().value)
    }
  }

  function has(slug) {
    return isSlug(slug) && slugs.has(slug)
  }

  return { add, has }
}

module.exports = { createSlugRegistry, isSlug, SLUG_PATTERN }
