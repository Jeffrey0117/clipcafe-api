function normalizeClip(clip) {
  return {
    slug: clip.slug,
    text: clip.title,
    mp4: clip.mp4Url,
    hls: clip.hlsUrl,
    movieTitle: clip.movie_title,
    movieYear: clip.movie_year,
    movieSlug: clip.movie_slug,
    imdb: clip.imdb,
    season: clip.season,
    episode: clip.episode,
    duration: clip.duration,
    quality: clip.quality,
    subLangs: clip.subLangs
  }
}

function stringList(value) {
  return (Array.isArray(value) ? value : []).filter(
    (item) => typeof item === 'string'
  )
}

function normalizeSearch(raw) {
  return {
    query: raw.query,
    total: Number(raw.total) || 0,
    from: Number(raw.from) || 0,
    size: Number(raw.size) || 0,
    slop: Number(raw.slop) || 0,
    results: (raw.results || []).map(normalizeClip),
    related: stringList(raw.related),
    didYouMean: stringList(raw.didYouMean)
  }
}

module.exports = { normalizeSearch }
