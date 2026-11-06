const fs = require('node:fs')
const path = require('node:path')

// pm2 does not inject .env files, so the app loads them itself.
// Later files win for keys not already present; real env always wins.
const ENV_FILES = ['.env', '.env.production']

function parseLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  return {
    key: trimmed.slice(0, eq).trim(),
    value: trimmed.slice(eq + 1).trim()
  }
}

function loadEnv(dir, env = process.env) {
  const fromFiles = {}
  for (const name of ENV_FILES) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const pair = parseLine(line)
      if (pair) fromFiles[pair.key] = pair.value
    }
  }
  for (const [key, value] of Object.entries(fromFiles)) {
    if (env[key] === undefined) env[key] = value
  }
}

module.exports = { loadEnv }
