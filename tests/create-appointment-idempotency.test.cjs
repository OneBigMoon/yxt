const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const target = path.resolve(__dirname, '../cloudfunctions/createAppointment/index.js')

function loadMain(t) {
  const calls = { collection: 0, transaction: 0 }
  const db = {
    command: {},
    collection() {
      calls.collection += 1
      return {
        where() { return this },
        limit() { return this },
        get: async () => ({ data: [] })
      }
    },
    runTransaction() {
      calls.transaction += 1
      throw new Error('invalid request_id must not acquire a lock')
    }
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'current',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: 'patient-openid' })
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk' && parent.filename === target) return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[target]
  t.after(() => {
    Module._load = originalLoad
    delete require.cache[target]
  })
  return { main: require(target).main, calls }
}

test('missing request_id keeps the legacy path', async t => {
  const source = fs.readFileSync(target, 'utf8')
  assert.match(source, /if \(hasRequestId && !\/\^\[a-zA-Z0-9_-\]\{8,64\}\$\/\.test\(requestId\)\)/)
  assert.match(source, /\.\.\.\(requestId \? \{[\s\S]{0,120}request_fingerprint: requestFingerprint/)

  const { main, calls } = loadMain(t)
  const result = await main({ services: ['service-1'], date: '2099-01-01', start_time: '10:00' })
  assert.deepEqual(result, { code: -1, message: '请先登录后预约' })
  assert.deepEqual(calls, { collection: 1, transaction: 0 })
})

test('present invalid request_id is rejected before database access', async t => {
  const { main, calls } = loadMain(t)
  for (const request_id of ['', 'short', 'contains spaces']) {
    const result = await main({ services: ['service-1'], date: '2099-01-01', start_time: '10:00', request_id })
    assert.deepEqual(result, { code: -1, message: '预约请求参数异常，请刷新后重试' })
  }
  assert.deepEqual(calls, { collection: 0, transaction: 0 })
})

test('present valid request_id reaches the normal request path', async t => {
  const { main, calls } = loadMain(t)
  const result = await main({
    services: ['service-1'],
    date: '2099-01-01',
    start_time: '10:00',
    request_id: 'legacy-safe_123'
  })
  assert.deepEqual(result, { code: -1, message: '请先登录后预约' })
  assert.deepEqual(calls, { collection: 1, transaction: 0 })
})
