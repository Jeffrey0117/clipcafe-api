const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const EXE_NAMES = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
const STDERR_TAIL_BYTES = 600
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024
const SOURCE_SUFFIX = '.src.tmp'

function firstExisting(candidates, existsSync) {
  return candidates.find((candidate) => existsSync(candidate)) || null
}

function fromPath(env, existsSync) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  const candidates = dirs.flatMap((dir) => EXE_NAMES.map((name) => path.join(dir, name)))
  return firstExisting(candidates, existsSync)
}

function listDir(dir, readdirSync) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// winget 把 ffmpeg 裝在帶版號的資料夾裡,而且不一定在 pm2 daemon 的 PATH 上
function fromWinget(env, existsSync, readdirSync) {
  if (!env.LOCALAPPDATA) return null
  const base = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
  const candidates = listDir(base, readdirSync)
    .filter((pkg) => pkg.startsWith('Gyan.FFmpeg'))
    .flatMap((pkg) =>
      listDir(path.join(base, pkg), readdirSync)
        .filter((inner) => inner.startsWith('ffmpeg-'))
        .map((inner) => path.join(base, pkg, inner, 'bin', 'ffmpeg.exe'))
    )
  return firstExisting(candidates, existsSync)
}

// 只查檔案系統,不試跑 ffmpeg — pm2 底下試跑會跳黑視窗
function findFfmpeg({
  env = process.env,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync
} = {}) {
  if (env.FFMPEG_PATH && existsSync(env.FFMPEG_PATH)) return env.FFMPEG_PATH
  return fromPath(env, existsSync) || fromWinget(env, existsSync, readdirSync)
}

function inputArgs(input) {
  return input.remote
    ? ['-protocol_whitelist', 'https,tls,tcp', '-rw_timeout', '10000000']
    : ['-protocol_whitelist', 'file']
}

function frameArgs({ input, outputPath, seekSeconds, width }) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    ...inputArgs(input),
    '-ss', String(seekSeconds),
    '-i', input.location,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '5',
    '-f', 'image2',
    '-y',
    outputPath
  ]
}

function hasOutput(outputPath) {
  try {
    return fs.statSync(outputPath).size > 0
  } catch {
    return false
  }
}

function fatal(err) {
  return Object.assign(err, { fatal: true })
}

function runOnce({ ffmpegPath, spawnImpl, timeoutMs, args, outputPath }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderrTail = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    function settle(fn, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }

    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (err) => settle(reject, fatal(err)))
    child.on('close', (code) => {
      if (timedOut) {
        return settle(reject, fatal(new Error(`ffmpeg timed out after ${timeoutMs}ms`)))
      }
      if (code !== 0) {
        return settle(reject, new Error(`ffmpeg exited with ${code}: ${stderrTail.trim()}`))
      }
      if (!hasOutput(outputPath)) return settle(reject, new Error('ffmpeg produced no output'))
      return settle(resolve)
    })
  })
}

async function downloadToFile(url, file, { fetchImpl = globalThis.fetch, timeoutMs }) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`download responded with ${res.status}`)
  const handle = await fs.promises.open(file, 'w')
  try {
    let total = 0
    for await (const chunk of res.body) {
      total += chunk.byteLength
      if (total > DOWNLOAD_MAX_BYTES) throw new Error('download exceeded the size limit')
      await handle.write(chunk)
    }
  } finally {
    await handle.close()
  }
}

// 抽一格當縮圖。
// 1. 先讓 ffmpeg 直接讀網址(只抓需要的片段,最快)。
// 2. clip.cafe 有些檔不支援分段讀取,直讀會壞 → 整支下載到暫存檔再抽。
// 抓 0.5 秒處是因為片頭第一格常常是黑的;片子太短抓不到就退回第一格。
function createFrameExtractor({
  ffmpegPath,
  spawnImpl = spawn,
  downloadImpl = downloadToFile,
  timeoutMs = 20_000,
  width = 480
}) {
  function attempt(input, seekSeconds, outputPath) {
    const args = frameArgs({ input, outputPath, seekSeconds, width })
    return runOnce({ ffmpegPath, spawnImpl, timeoutMs, args, outputPath })
  }

  async function firstSuccess(attempts) {
    let lastError = null
    for (const run of attempts) {
      try {
        await run()
        return
      } catch (err) {
        // ffmpeg 起不來或逾時,再試也沒用
        if (err.fatal) throw err
        lastError = err
      }
    }
    throw lastError
  }

  async function extractFromDownload(url, outputPath) {
    const source = `${outputPath}${SOURCE_SUFFIX}`
    try {
      await downloadImpl(url, source, { timeoutMs })
      const local = { location: source, remote: false }
      await firstSuccess([
        () => attempt(local, 0.5, outputPath),
        () => attempt(local, 0, outputPath)
      ])
    } finally {
      await fs.promises.rm(source, { force: true })
    }
  }

  return async function extract({ url, outputPath }) {
    await firstSuccess([
      () => attempt({ location: url, remote: true }, 0.5, outputPath),
      () => extractFromDownload(url, outputPath)
    ])
  }
}

module.exports = { findFfmpeg, createFrameExtractor }
