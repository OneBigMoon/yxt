const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const {
  ADMIN_LOGIN_FAILURE_LIMIT,
  ADMIN_LOGIN_FAILURE_WINDOW_MS,
  ADMIN_LOGIN_LOCK_MS,
  SCAN_QR_CREATE_COOLDOWN_MS,
  createBrowserSecret,
  createCallerBoundSessionId,
  getActiveLoginLock,
  getCloudbaseUidFromContext,
  getScanQrRetryAfter,
  hashBrowserSecret,
  nextLoginFailureState,
  sanitizeAuditChanges,
  verifyBrowserSecret
} = require('../cloudfunctions/admin/authSecurity')

test('scan browser secrets are random, hashed and timing-safe verified', () => {
  const first = createBrowserSecret()
  const second = createBrowserSecret()
  const hash = hashBrowserSecret(first)

  assert.match(first, /^[a-f0-9]{64}$/)
  assert.notEqual(first, second)
  assert.notEqual(hash, first)
  assert.equal(verifyBrowserSecret(first, hash), true)
  assert.equal(verifyBrowserSecret(second, hash), false)
  assert.equal(verifyBrowserSecret('', hash), false)
})

test('scan login session ids are stable per trusted caller and isolated across callers', () => {
  const first = createCallerBoundSessionId('anonymous-user-a')
  assert.match(first, /^[a-f0-9]{32}$/)
  assert.equal(first, createCallerBoundSessionId('anonymous-user-a'))
  assert.notEqual(first, createCallerBoundSessionId('anonymous-user-b'))
  assert.equal(createCallerBoundSessionId(''), '')
})

test('scan QR creation cooldown returns only the remaining caller window', () => {
  const now = 1_800_000_000_000
  assert.equal(getScanQrRetryAfter({}, now), 0)
  assert.equal(
    getScanQrRetryAfter({ qr_requested_at: now - 1000 }, now),
    SCAN_QR_CREATE_COOLDOWN_MS - 1000
  )
  assert.equal(getScanQrRetryAfter({ qr_requested_at: now - SCAN_QR_CREATE_COOLDOWN_MS }, now), 0)
})

test('CloudBase caller uid is read from current and legacy context formats', () => {
  assert.equal(getCloudbaseUidFromContext({ environment: '{"TCB_UUID":"json-user"}' }), 'json-user')
  assert.equal(getCloudbaseUidFromContext({ environ: 'TCB_ENV=test;TCB_UUID=legacy-user;OTHER=1' }), 'legacy-user')
  assert.equal(getCloudbaseUidFromContext({ environment: { TCB_UUID: 'object-user' } }), 'object-user')
  assert.equal(getCloudbaseUidFromContext({ environment: '{invalid' }), '')
})

test('password failures reset by window and lock at the configured limit', () => {
  const now = 1_800_000_000_000
  let account = {}

  for (let attempt = 1; attempt <= ADMIN_LOGIN_FAILURE_LIMIT; attempt += 1) {
    const state = nextLoginFailureState(account, now + attempt)
    assert.equal(state.failedAttempts, attempt)
    account = {
      failed_login_attempts: state.failedAttempts,
      login_failure_window_started_at: state.windowStartedAt,
      login_locked_until: state.lockedUntil
    }
  }

  assert.equal(getActiveLoginLock(account, now + ADMIN_LOGIN_FAILURE_LIMIT), now + ADMIN_LOGIN_FAILURE_LIMIT + ADMIN_LOGIN_LOCK_MS)
  assert.equal(nextLoginFailureState(account, now + ADMIN_LOGIN_FAILURE_WINDOW_MS + 1).failedAttempts, 1)
})

test('audit changes remove credentials and redact personal values', () => {
  assert.deepEqual(sanitizeAuditChanges({
    password_hash: 'derived-secret',
    admin_token: 'token',
    phone: '13800000000',
    service_name: '标准服务',
    technician_name: '值班顾问',
    nested: { browser_secret: 'secret', role: 'manager' }
  }), {
    phone: '[redacted]',
    service_name: '标准服务',
    technician_name: '值班顾问',
    nested: { role: 'manager' }
  })
})

test('admin cloud and web API require the browser secret and persistent rate limit', () => {
  const cloud = fs.readFileSync(path.join(root, 'cloudfunctions/admin/index.js'), 'utf8')
  const api = fs.readFileSync(path.join(root, 'admin-web/src/api/index.js'), 'utf8')

  assert.match(cloud, /browser_secret_hash: hashBrowserSecret\(browserSecret\)/)
  assert.match(cloud, /browser_secret_version: 1/)
  assert.match(cloud, /crypto\.randomBytes\(16\)\.toString\('hex'\)/)
  assert.match(cloud, /hasValidScanBrowserSecret\(data, sessionData\)/)
  assert.match(cloud, /hasValidScanBrowserSecret\(data, session\)/)
  assert.match(cloud, /db\.runTransaction\(async transaction/)
  assert.match(cloud, /getActiveLoginLock\(currentAccount, now\)/)
  assert.match(cloud, /reserveAdminLoginAttempt\(account\._id\)/)
  const verifyFunction = cloud.slice(
    cloud.indexOf('async function verifyAdminPassword'),
    cloud.indexOf('async function reserveAdminLoginAttempt')
  )
  const passwordCheckAt = verifyFunction.indexOf('verifyPasswordHash(data.password, account.password_hash)')
  const reserveAt = verifyFunction.indexOf('reserveAdminLoginAttempt(account._id)')
  const denyAt = verifyFunction.indexOf('if (!loginAttempt.allowed)')
  const clearAt = verifyFunction.indexOf('clearAdminLoginFailures(account._id)')
  assert.ok(reserveAt >= 0 && reserveAt < passwordCheckAt, 'an attempt must atomically reserve capacity before password hashing')
  assert.ok(denyAt > reserveAt && denyAt < passwordCheckAt, 'an exhausted attempt budget must reject before password hashing')
  assert.ok(clearAt > passwordCheckAt, 'a valid password must clear any existing failure lock')
  assert.doesNotMatch(verifyFunction.slice(passwordCheckAt), /reserveAdminLoginAttempt/)
  assert.doesNotMatch(cloud, /账号已停用，请联系管理员|USER_DISABLED/)
  assert.doesNotMatch(cloud, /markRejected\([^\n]*(?:err|error)\.message/)
  assert.doesNotMatch(cloud, /browser_secret:\s*browserSecret[\s\S]{0,300}login_sessions/)
  assert.doesNotMatch(cloud, /微信 API 请求超时：\$\{method\} \$\{url\}/)
  assert.doesNotMatch(cloud, /console\.error\('生成微信小程序码失败:', err\)/)
  assert.match(cloud, /changes: options\.changes \? sanitizeAuditChanges\(options\.changes\) : null/)
  assert.match(cloud, /delete safe\.openid/)
  assert.match(api, /const scanSessionSecrets = new Map\(\)/)
  assert.match(api, /browser_secret: scanSessionSecrets\.get\(sessionId\) \|\| ''/)
})

test('concurrent password attempts receive a serialized pre-hash budget', async () => {
  const cloud = fs.readFileSync(path.join(root, 'cloudfunctions/admin/index.js'), 'utf8')
  const source = cloud.slice(
    cloud.indexOf('async function reserveAdminLoginAttempt'),
    cloud.indexOf('async function clearAdminLoginFailures')
  )
  const account = {}
  let queue = Promise.resolve()
  const transaction = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { data: { ...account } }
            },
            async update({ data }) {
              Object.assign(account, data)
            }
          }
        }
      }
    }
  }
  const db = {
    serverDate() {
      return 1_800_000_000_000
    },
    runTransaction(callback) {
      const current = queue.then(() => callback(transaction))
      queue = current.catch(() => {})
      return current
    }
  }
  const reserve = Function(
    'db',
    'getActiveLoginLock',
    'nextLoginFailureState',
    `${source}\nreturn reserveAdminLoginAttempt`
  )(db, getActiveLoginLock, nextLoginFailureState)

  const now = 1_800_000_000_000
  const results = await Promise.all(
    Array.from({ length: ADMIN_LOGIN_FAILURE_LIMIT + 3 }, () => reserve('admin-1', now))
  )

  assert.equal(results.filter(result => result.allowed).length, ADMIN_LOGIN_FAILURE_LIMIT - 1)
  assert.equal(results.filter(result => !result.allowed).length, 4)
  assert.equal(getActiveLoginLock(account, now), now + ADMIN_LOGIN_LOCK_MS)
})

test('cloud function boundaries hide raw errors and avoid risk-bearing SDK entry points', () => {
  const files = [
    'admin',
    'cancelAppointment',
    'checkAvailability',
    'createAppointment',
    'getAppointments',
    'getArticleDetail',
    'getArticles',
    'getAvailableSlots',
    'getMyAppointments',
    'getServices',
    'login',
    'sendReminder',
    'verifyAppointment'
  ]

  for (const name of files) {
    const source = fs.readFileSync(path.join(root, 'cloudfunctions', name, 'index.js'), 'utf8')
    assert.doesNotMatch(source, /return[^\n]*(?:err|error)\.message/, `${name} exposes an exception message`)
    assert.doesNotMatch(source, /\.watch\s*\(|\brequestClient\b|\bserviceUrl\b|HTTP_PROXY|HTTPS_PROXY/)
    assert.doesNotMatch(source, /cloud\.openapi\s*\[/)
    assert.doesNotMatch(source, /\bdata:\s*(?:event|data|params)\b/)
  }
})

test('production admin login has no automatic first-admin bootstrap path', () => {
  const cloud = fs.readFileSync(path.join(root, 'cloudfunctions/admin/index.js'), 'utf8')

  assert.doesNotMatch(cloud, /ADMIN_BOOTSTRAP_USERNAME|ADMIN_BOOTSTRAP_PASSWORD/)
  assert.doesNotMatch(cloud, /tryBootstrapFirstAdmin|bootstrapped:\s*true|首次登录自动创建/)
})

test('legacy password verification requires an explicit migration salt', () => {
  const cloud = fs.readFileSync(path.join(root, 'cloudfunctions/admin/index.js'), 'utf8')

  assert.match(cloud, /const ADMIN_PASSWORD_SALT = process\.env\.ADMIN_PASSWORD_SALT \|\| ''/)
  assert.match(cloud, /if \(!ADMIN_PASSWORD_SALT \|\| !\/\^\[a-f0-9\]\{64\}\$\/i\.test\(normalizedHash\)\)/)
  assert.doesNotMatch(cloud, /yxt-admin-salt/)
})
