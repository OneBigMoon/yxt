const crypto = require('crypto')

const ADMIN_LOGIN_FAILURE_LIMIT = 5
const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000
const ADMIN_LOGIN_LOCK_MS = 15 * 60 * 1000
const SCAN_QR_CREATE_COOLDOWN_MS = 30 * 1000
const BROWSER_SECRET_PATTERN = /^[a-f0-9]{64}$/
const AUDIT_SECRET_KEY_PATTERN = /password|passcode|secret|token|credential|authorization|cookie|session/i
const AUDIT_PERSONAL_KEY_PATTERN = /^(?:openid|patient_openid|customer_openid|user_openid|admin_openid|phone|patient_phone|customer_phone|mobile|avatar|avatar_url|avatarurl|nickname|nick_name|remark|address|id_card|realname|real_name|user_name|username|patient_name|customer_name)$/i

function createBrowserSecret() {
  return crypto.randomBytes(32).toString('hex')
}

function createCallerBoundSessionId(callerId) {
  const normalized = String(callerId || '').trim()
  if (!normalized || normalized.length > 256) return ''
  return crypto.createHash('sha256').update(`admin_login\u0000${normalized}`).digest('hex').slice(0, 32)
}

function getScanQrRetryAfter(session = {}, now = Date.now()) {
  const requestedAt = Number(session.qr_requested_at || 0)
  const currentTime = Number(now)
  if (!Number.isFinite(requestedAt) || requestedAt <= 0 || !Number.isFinite(currentTime)) return 0
  return Math.max(0, requestedAt + SCAN_QR_CREATE_COOLDOWN_MS - currentTime)
}

function getCloudbaseUidFromContext(context = {}) {
  const current = context.environment
  if (current && typeof current === 'object') {
    return String(current.TCB_UUID || '').trim()
  }
  if (typeof current === 'string' && current.trim()) {
    try {
      return String(JSON.parse(current).TCB_UUID || '').trim()
    } catch {}
  }

  const legacy = context.environ
  if (legacy && typeof legacy === 'object') {
    return String(legacy.TCB_UUID || '').trim()
  }
  if (typeof legacy === 'string') {
    const prefix = 'TCB_UUID='
    const item = legacy.split(';').find(entry => entry.startsWith(prefix))
    return item ? item.slice(prefix.length).trim() : ''
  }
  return ''
}

function hashBrowserSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex')
}

function verifyBrowserSecret(secret, expectedHash) {
  if (!BROWSER_SECRET_PATTERN.test(String(secret || '')) ||
      !BROWSER_SECRET_PATTERN.test(String(expectedHash || ''))) {
    return false
  }

  return crypto.timingSafeEqual(
    Buffer.from(hashBrowserSecret(secret), 'hex'),
    Buffer.from(expectedHash, 'hex')
  )
}

function getActiveLoginLock(account = {}, now = Date.now()) {
  const lockedUntil = Number(account.login_locked_until || 0)
  return lockedUntil > now ? lockedUntil : 0
}

function nextLoginFailureState(account = {}, now = Date.now()) {
  const windowStartedAt = Number(account.login_failure_window_started_at || 0)
  const inCurrentWindow = windowStartedAt > 0 &&
    now >= windowStartedAt &&
    now - windowStartedAt < ADMIN_LOGIN_FAILURE_WINDOW_MS
  const failedAttempts = (inCurrentWindow ? Number(account.failed_login_attempts || 0) : 0) + 1

  return {
    failedAttempts,
    windowStartedAt: inCurrentWindow ? windowStartedAt : now,
    lockedUntil: failedAttempts >= ADMIN_LOGIN_FAILURE_LIMIT ? now + ADMIN_LOGIN_LOCK_MS : 0
  }
}

function sanitizeAuditChanges(value) {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeAuditChanges(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.entries(value).reduce((safe, [key, item]) => {
    if (AUDIT_SECRET_KEY_PATTERN.test(key)) {
      return safe
    }
    safe[key] = AUDIT_PERSONAL_KEY_PATTERN.test(key)
      ? '[redacted]'
      : sanitizeAuditChanges(item)
    return safe
  }, {})
}

module.exports = {
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
}
