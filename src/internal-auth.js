const crypto = require('node:crypto')

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(a).digest()
  const right = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(left, right)
}

// 這支服務只給自家後端呼叫。設了金鑰之後,沒帶對 Bearer 的請求一律 401 —
// 就算有人從公開網域繞進來,也拿不到搜尋結果、片源和字幕。
// 沒設金鑰 = 本機開發模式,全部放行(啟動時會警告)。
function createInternalAuth({ key }) {
  const enabled = typeof key === 'string' && key.length > 0

  function middleware(req, res, next) {
    if (!enabled) return next()
    const header = req.get('Authorization') || ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (presented && safeEqual(presented, key)) return next()
    res.set('Cache-Control', 'no-store')
    return res.status(401).json({ success: false, error: 'unauthorized' })
  }

  return { enabled, middleware }
}

module.exports = { createInternalAuth }
