const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const target = path.resolve(__dirname, '../cloudfunctions/admin/index.js')
const authSecurity = path.resolve(__dirname, '../cloudfunctions/admin/authSecurity.js')

function loadAdmin(t, options = {}) {
  const originalWechatAppid = process.env.WECHAT_APPID
  const originalWechatAppSecret = process.env.WECHAT_APPSECRET
  const originalAdminHstsMaxAgeSeconds = process.env.ADMIN_HSTS_MAX_AGE_SECONDS
  process.env.WECHAT_APPID = 'test-appid'
  process.env.WECHAT_APPSECRET = 'test-appsecret'
  if (options.hstsMaxAgeSeconds === undefined) delete process.env.ADMIN_HSTS_MAX_AGE_SECONDS
  else process.env.ADMIN_HSTS_MAX_AGE_SECONDS = options.hstsMaxAgeSeconds

  const state = {
    now: 1_800_000_000_000,
    records: new Map(),
    qrCalls: 0,
    missingTransactionReads: 0,
    transactionCalls: 0
  }
  const records = name => {
    if (!state.records.has(name)) state.records.set(name, new Map())
    return state.records.get(name)
  }
  const matches = (record, query) => Object.entries(query).every(([key, value]) => {
    if (value && value.__neq !== undefined) return record[key] !== value.__neq
    if (value && value.__lt !== undefined) return record[key] < value.__lt
    return record[key] === value
  })
  const makeCollection = (name, pending) => {
    let query = {}
    const read = id => (pending && pending.has(`${name}:${id}`))
      ? pending.get(`${name}:${id}`)
      : records(name).get(id)
    const write = (id, data, merge) => {
      const next = merge ? { ...(read(id) || {}), ...data } : { _id: id, ...data }
      if (pending) pending.set(`${name}:${id}`, next)
      else records(name).set(id, next)
    }
    return {
      where(next) { query = { ...query, ...next }; return this },
      limit() { return this },
      skip() { return this },
      orderBy() { return this },
      async get() { return { data: [...records(name).values()].filter(record => matches(record, query)) } },
      async add({ data }) { records(name).set(data._id || `${name}-${records(name).size + 1}`, { ...data }) },
      doc(id) {
        return {
          async get() {
            const data = read(id)
            if (pending && !data) {
              state.missingTransactionReads += 1
              throw new Error(`document.get:fail document with _id ${id} does not exist`)
            }
            return { data }
          },
          async set({ data }) { write(id, data, false) },
          async update({ data }) { write(id, data, true) }
        }
      }
    }
  }
  const db = {
    command: {
      neq: value => ({ __neq: value }),
      lt: value => ({ __lt: value })
    },
    collection: name => makeCollection(name),
    serverDate: () => 'server-date',
    async runTransaction(callback) {
      state.transactionCalls += 1
      const pending = new Map()
      const result = await callback({ collection: name => makeCollection(name, pending) })
      for (const [key, value] of pending) {
        const [name, id] = key.split(':')
        records(name).set(id, value)
      }
      return result
    }
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'current',
    init() {},
    database: () => db,
    openapi: {
      wxacode: {
        async getUnlimited() {
          state.qrCalls += 1
          return { buffer: Buffer.from('qr') }
        }
      }
    }
  }
  const originalLoad = Module._load
  const originalNow = Date.now
  const originalConsoleError = console.error
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk' && parent && parent.filename === target) return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  Date.now = () => state.now
  console.error = () => {}
  delete require.cache[target]
  t.after(() => {
    Module._load = originalLoad
    Date.now = originalNow
    console.error = originalConsoleError
    if (originalWechatAppid === undefined) delete process.env.WECHAT_APPID
    else process.env.WECHAT_APPID = originalWechatAppid
    if (originalWechatAppSecret === undefined) delete process.env.WECHAT_APPSECRET
    else process.env.WECHAT_APPSECRET = originalWechatAppSecret
    if (originalAdminHstsMaxAgeSeconds === undefined) delete process.env.ADMIN_HSTS_MAX_AGE_SECONDS
    else process.env.ADMIN_HSTS_MAX_AGE_SECONDS = originalAdminHstsMaxAgeSeconds
    delete require.cache[target]
  })
  return { main: require(target).main, state }
}

test('health action is read-only without exposing the deployed package version', async t => {
  const { main, state } = loadAdmin(t)
  const result = await main({ action: 'health', trace_id: 'health-check' }, {})

  assert.deepEqual(result, {
    code: 0,
    data: { status: 'ok', service: 'admin' },
    trace_id: 'health-check'
  })
  assert.equal(state.transactionCalls, 0)
  assert.equal(state.records.size, 0)
})

test('HTTP health probe is public, deterministic and hardened', async t => {
  const { main, state } = loadAdmin(t)
  const result = await main({
    httpMethod: 'GET',
    queryStringParameters: { action: 'health' }
  }, {})

  assert.equal(result.statusCode, 200)
  assert.deepEqual(JSON.parse(result.body), { status: 'ok', service: 'admin' })
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.equal(result.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(result.headers['Content-Security-Policy'], "default-src 'none'; base-uri 'none'; frame-ancestors 'none'")
  assert.equal(result.headers['Permissions-Policy'], 'camera=(), geolocation=(), microphone=()')
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer')
  assert.equal(result.headers['Strict-Transport-Security'], 'max-age=300')
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(result.headers['X-Frame-Options'], 'DENY')
  assert.equal(state.transactionCalls, 0)
  assert.equal(state.records.size, 0)
})

test('HTTP admin entry serves the built shell with browser security headers', async t => {
  const { main, state } = loadAdmin(t)
  const result = await main({ httpMethod: 'GET', queryStringParameters: {} }, {})

  assert.equal(result.statusCode, 200)
  assert.match(result.body, /<div id="app"><\/div>/)
  assert.match(result.body, /src="\/assets\//)
  assert.doesNotMatch(result.body, /["']\.\/assets\//)
  assert.doesNotMatch(result.body, /\/src\/main\.js/)
  assert.equal(result.headers['Content-Type'], 'text/html; charset=utf-8')
  assert.match(result.headers['Content-Security-Policy'], /script-src 'self'/)
  assert.equal(result.headers['Permissions-Policy'], 'camera=(), geolocation=(), microphone=()')
  assert.equal(result.headers['Strict-Transport-Security'], 'max-age=300')
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(result.headers['X-Frame-Options'], 'DENY')
  assert.equal(state.transactionCalls, 0)
  assert.equal(state.records.size, 0)
})

test('HTTP HSTS promotion emits the allowlisted one-year policy', async t => {
  const { main } = loadAdmin(t, { hstsMaxAgeSeconds: '31536000' })
  const result = await main({ httpMethod: 'GET', queryStringParameters: { action: 'health' } }, {})

  assert.equal(result.headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains')
})

test('HTTP HSTS rollback emits an explicit cache-clearing policy', async t => {
  const { main } = loadAdmin(t, { hstsMaxAgeSeconds: '0' })
  const result = await main({ httpMethod: 'GET', queryStringParameters: { action: 'health' } }, {})

  assert.equal(result.headers['Strict-Transport-Security'], 'max-age=0')
})

test('HTTP HSTS rejects arbitrary configuration and falls back to canary', async t => {
  const { main } = loadAdmin(t, { hstsMaxAgeSeconds: '999999999' })
  const result = await main({ httpMethod: 'GET', queryStringParameters: { action: 'health' } }, {})

  assert.equal(result.headers['Strict-Transport-Security'], 'max-age=300')
})

test('one caller can create only one scan QR per cooldown without replacing its session', async t => {
  const { SCAN_QR_CREATE_COOLDOWN_MS, createCallerBoundSessionId, getScanQrRetryAfter } = require(authSecurity)
  assert.equal(typeof SCAN_QR_CREATE_COOLDOWN_MS, 'number')
  assert.ok(SCAN_QR_CREATE_COOLDOWN_MS > 0)
  assert.equal(typeof getScanQrRetryAfter, 'function')

  const { main, state } = loadAdmin(t)
  const context = { environment: { TCB_UUID: 'same-anonymous-caller' } }
  const first = await main({ action: 'createLoginSession', data: {} }, context)
  assert.equal(first.code, 0)
  assert.equal(state.qrCalls, 1)
  assert.equal(state.missingTransactionReads, 1)
  assert.equal(state.transactionCalls, 1)

  const sessionId = first.data.session_id
  const reservationId = createCallerBoundSessionId('same-anonymous-caller')
  assert.notEqual(sessionId, reservationId)
  const firstSession = state.records.get('login_sessions').get(sessionId)
  const firstSecret = first.data.browser_secret
  assert.equal(getScanQrRetryAfter(state.records.get('login_sessions').get(reservationId), state.now), SCAN_QR_CREATE_COOLDOWN_MS)

  const second = await main({ action: 'createLoginSession', data: {} }, context)
  assert.equal(second.code, -1)
  assert.equal(second.error_code, 'RATE_LIMITED')
  assert.equal(state.qrCalls, 1)
  assert.equal(state.transactionCalls, 2)
  assert.deepEqual(state.records.get('login_sessions').get(sessionId), firstSession)
  assert.equal(first.data.browser_secret, firstSecret)

  state.now += SCAN_QR_CREATE_COOLDOWN_MS
  const third = await main({ action: 'createLoginSession', data: {} }, context)
  assert.equal(third.code, 0)
  assert.equal(state.qrCalls, 2)
  assert.equal(state.transactionCalls, 3)
  assert.notEqual(third.data.session_id, sessionId)
  assert.deepEqual(state.records.get('login_sessions').get(sessionId), firstSession)
})
