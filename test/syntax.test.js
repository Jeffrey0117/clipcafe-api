const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')

// server.js 沒有其他測試會載入它,語法壞掉要到部署才爆 — 這裡先擋
function sourceFiles() {
  const src = fs
    .readdirSync(path.join(ROOT, 'src'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join('src', name))
  return ['server.js', ...src]
}

for (const file of sourceFiles()) {
  test(`${file} parses`, () => {
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], {
        stdio: 'pipe',
        windowsHide: true
      })
    )
  })
}

test('no source file has a string literal broken across lines by a stray newline', () => {
  for (const file of sourceFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)
    const broken = lines.findIndex((line) => /^[`'"]\)$/.test(line.trim()))
    assert.equal(broken, -1, `${file}:${broken + 1} looks like a log line split by a raw newline`)
  }
})
