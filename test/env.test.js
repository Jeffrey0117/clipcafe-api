const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { loadEnv } = require('../src/env')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'))
}

test('loadEnv reads KEY=VALUE pairs from .env files', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, '.env'), 'ENVTEST_A=hello\nENVTEST_B=1\n')
  const env = {}
  loadEnv(dir, env)
  assert.equal(env.ENVTEST_A, 'hello')
  assert.equal(env.ENVTEST_B, '1')
})

test('loadEnv skips comments and blank lines, trims whitespace', () => {
  const dir = tempDir()
  fs.writeFileSync(
    path.join(dir, '.env'),
    '# comment\n\n  ENVTEST_C = spaced value \n'
  )
  const env = {}
  loadEnv(dir, env)
  assert.equal(env.ENVTEST_C, 'spaced value')
})

test('loadEnv never overrides existing values', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, '.env'), 'ENVTEST_D=file\n')
  const env = { ENVTEST_D: 'existing' }
  loadEnv(dir, env)
  assert.equal(env.ENVTEST_D, 'existing')
})

test('loadEnv prefers .env.production over .env for new keys', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, '.env'), 'ENVTEST_E=dev\n')
  fs.writeFileSync(path.join(dir, '.env.production'), 'ENVTEST_E=prod\n')
  const env = {}
  loadEnv(dir, env)
  assert.equal(env.ENVTEST_E, 'prod')
})

test('loadEnv is a no-op when no env files exist', () => {
  const dir = tempDir()
  const env = {}
  loadEnv(dir, env)
  assert.deepEqual(env, {})
})
