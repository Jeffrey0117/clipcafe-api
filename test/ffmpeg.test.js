const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { findFfmpeg, createFrameExtractor } = require('../src/ffmpeg')

function fakeFs(files, dirs = {}) {
  const normalized = new Set(files.map((f) => path.normalize(f)))
  return {
    existsSync: (p) => normalized.has(path.normalize(p)),
    readdirSync: (p) => {
      const entries = dirs[path.normalize(p)]
      if (!entries) throw new Error('ENOENT')
      return entries
    }
  }
}

test('findFfmpeg prefers FFMPEG_PATH when it exists', () => {
  const explicit = path.join('X:', 'tools', 'ffmpeg.exe')
  const found = findFfmpeg({
    env: { FFMPEG_PATH: explicit, PATH: '' },
    ...fakeFs([explicit])
  })
  assert.equal(found, explicit)
})

test('findFfmpeg searches PATH directories', () => {
  const dir = path.join('X:', 'bin')
  const exe = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const found = findFfmpeg({
    env: { PATH: [path.join('X:', 'other'), dir].join(path.delimiter) },
    ...fakeFs([exe])
  })
  assert.equal(found, exe)
})

test('findFfmpeg falls back to the winget install dir', () => {
  const base = path.join('X:', 'Local', 'Microsoft', 'WinGet', 'Packages')
  const pkg = 'Gyan.FFmpeg_Microsoft.Winget.Source_abc'
  const build = 'ffmpeg-8.1.2-full_build'
  const exe = path.join(base, pkg, build, 'bin', 'ffmpeg.exe')
  const found = findFfmpeg({
    env: { PATH: '', LOCALAPPDATA: path.join('X:', 'Local') },
    ...fakeFs([exe], {
      [path.normalize(base)]: ['Other.Package', pkg],
      [path.normalize(path.join(base, pkg))]: ['LICENSE', build]
    })
  })
  assert.equal(found, exe)
})

test('findFfmpeg returns null when ffmpeg is nowhere', () => {
  const found = findFfmpeg({
    env: { PATH: path.join('X:', 'bin'), LOCALAPPDATA: path.join('X:', 'Local') },
    ...fakeFs([])
  })
  assert.equal(found, null)
})

// 假的 child process:依序吃 outcomes,每個 outcome 決定這次 ffmpeg 的結局
function fakeSpawn(outcomes) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('close', null, 'SIGKILL'))
    }
    const outcome = outcomes[calls.length] || { code: 1 }
    calls.push({ command, args, options, child })
    if (outcome.hang) return child
    setImmediate(() => {
      if (outcome.error) return child.emit('error', outcome.error)
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
      if (outcome.code === 0) fs.writeFileSync(args[args.length - 1], 'jpeg')
      child.emit('close', outcome.code)
    })
    return child
  }
  return { spawnImpl, calls }
}

function outputPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcafe-ffmpeg-'))
  return path.join(dir, 'out.tmp')
}

const URL = 'https://clip.cafe/videos/some-clip.mp4'

function fakeDownload({ fail = false } = {}) {
  const calls = []
  const downloadImpl = async (url, file) => {
    calls.push({ url, file })
    if (fail) throw new Error('download responded with 404')
    fs.writeFileSync(file, 'mp4-bytes')
  }
  return { downloadImpl, calls }
}

const inputOf = (call) => call.args[call.args.indexOf('-i') + 1]
const seekOf = (call) => call.args[call.args.indexOf('-ss') + 1]

test('extract runs ffmpeg hidden, without a shell, and writes the frame', async () => {
  const { spawnImpl, calls } = fakeSpawn([{ code: 0 }])
  const download = fakeDownload()
  const extract = createFrameExtractor({
    ffmpegPath: 'X:/ffmpeg.exe',
    spawnImpl,
    downloadImpl: download.downloadImpl
  })
  const out = outputPath()

  await extract({ url: URL, outputPath: out })

  assert.equal(calls.length, 1)
  const { command, args, options } = calls[0]
  assert.equal(command, 'X:/ffmpeg.exe')
  assert.equal(options.windowsHide, true)
  assert.ok(!options.shell)
  assert.equal(inputOf(calls[0]), URL)
  assert.equal(args[args.indexOf('-frames:v') + 1], '1')
  assert.equal(args[args.length - 1], out)
  assert.ok(args.includes('-nostdin'))
  assert.ok(fs.existsSync(out))
  assert.equal(download.calls.length, 0)
})

test('extract downloads the clip when reading the URL directly fails', async () => {
  const { spawnImpl, calls } = fakeSpawn([{ code: 1, stderr: 'partial file' }, { code: 0 }])
  const download = fakeDownload()
  const extract = createFrameExtractor({
    ffmpegPath: 'ffmpeg',
    spawnImpl,
    downloadImpl: download.downloadImpl
  })
  const out = outputPath()

  await extract({ url: URL, outputPath: out })

  assert.equal(calls.length, 2)
  assert.equal(download.calls.length, 1)
  assert.equal(download.calls[0].url, URL)
  const localSource = download.calls[0].file
  assert.equal(inputOf(calls[1]), localSource)
  assert.ok(calls[1].args.join(' ').includes('-protocol_whitelist file'))
  assert.ok(!fs.existsSync(localSource), 'downloaded source must be removed')
  assert.ok(fs.existsSync(out))
})

test('extract falls back to the very first frame for clips too short to seek', async () => {
  const { spawnImpl, calls } = fakeSpawn([
    { code: 1, stderr: 'no packets' },
    { code: 1, stderr: 'no packets' },
    { code: 0 }
  ])
  const extract = createFrameExtractor({
    ffmpegPath: 'ffmpeg',
    spawnImpl,
    downloadImpl: fakeDownload().downloadImpl
  })

  await extract({ url: URL, outputPath: outputPath() })

  assert.equal(calls.length, 3)
  assert.notEqual(seekOf(calls[1]), '0')
  assert.equal(seekOf(calls[2]), '0')
})

test('extract rejects with the ffmpeg error when every attempt fails', async () => {
  const { spawnImpl, calls } = fakeSpawn([
    { code: 1, stderr: 'Invalid data found' },
    { code: 1, stderr: 'Invalid data found' },
    { code: 1, stderr: 'Invalid data found' }
  ])
  const download = fakeDownload()
  const extract = createFrameExtractor({
    ffmpegPath: 'ffmpeg',
    spawnImpl,
    downloadImpl: download.downloadImpl
  })

  await assert.rejects(extract({ url: URL, outputPath: outputPath() }), /Invalid data found/)
  assert.equal(calls.length, 3)
  assert.ok(!fs.existsSync(download.calls[0].file), 'downloaded source must be removed')
})

test('extract rejects when the fallback download fails', async () => {
  const { spawnImpl, calls } = fakeSpawn([{ code: 1, stderr: 'Server returned 404 Not Found' }])
  const extract = createFrameExtractor({
    ffmpegPath: 'ffmpeg',
    spawnImpl,
    downloadImpl: fakeDownload({ fail: true }).downloadImpl
  })

  await assert.rejects(extract({ url: URL, outputPath: outputPath() }), /download responded with 404/)
  assert.equal(calls.length, 1)
})

test('extract gives up immediately when ffmpeg cannot be started', async () => {
  const { spawnImpl, calls } = fakeSpawn([{ error: new Error('spawn ENOENT') }])
  const download = fakeDownload()
  const extract = createFrameExtractor({
    ffmpegPath: 'ffmpeg',
    spawnImpl,
    downloadImpl: download.downloadImpl
  })

  await assert.rejects(extract({ url: URL, outputPath: outputPath() }), /ENOENT/)
  assert.equal(calls.length, 1)
  assert.equal(download.calls.length, 0)
})

test('extract kills ffmpeg and gives up when it runs past the timeout', async () => {
  const { spawnImpl, calls } = fakeSpawn([{ hang: true }])
  const download = fakeDownload()
  const extract = createFrameExtractor({
    ffmpegPath: 'ffmpeg',
    spawnImpl,
    downloadImpl: download.downloadImpl,
    timeoutMs: 20
  })

  await assert.rejects(extract({ url: URL, outputPath: outputPath() }), /timed out/)
  assert.equal(calls[0].child.killed, true)
  assert.equal(calls.length, 1)
  assert.equal(download.calls.length, 0)
})

test('extract rejects when ffmpeg exits cleanly but wrote no file', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => child.emit('close', 0))
    return child
  }
  const extract = createFrameExtractor({
    ffmpegPath: 'ffmpeg',
    spawnImpl,
    downloadImpl: fakeDownload().downloadImpl
  })

  await assert.rejects(extract({ url: URL, outputPath: outputPath() }), /no output/)
})
