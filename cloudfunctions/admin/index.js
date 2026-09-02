const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { hasRestrictedPublicContent } = require('./articlePolicy')
const {
  createBrowserSecret,
  createCallerBoundSessionId,
  getActiveLoginLock,
  getCloudbaseUidFromContext,
  getScanQrRetryAfter,
  hashBrowserSecret,
  nextLoginFailureState,
  sanitizeAuditChanges,
  verifyBrowserSecret
} = require('./authSecurity')
const { buildProductionSeed, PRODUCTION_SEED_VERSION } = require('./productionSeed')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const wechatTokenCache = { token: '', expireAt: 0 }
const REQUEST_TIMEOUT_MS = 8000
const ADMIN_HSTS_MAX_AGE_OPTIONS = new Set(['0', '300', '31536000'])
const ADMIN_HSTS_MAX_AGE_SECONDS = ADMIN_HSTS_MAX_AGE_OPTIONS.has(process.env.ADMIN_HSTS_MAX_AGE_SECONDS)
  ? process.env.ADMIN_HSTS_MAX_AGE_SECONDS
  : '300'
const ADMIN_HSTS_HEADER = `max-age=${ADMIN_HSTS_MAX_AGE_SECONDS}${ADMIN_HSTS_MAX_AGE_SECONDS === '31536000' ? '; includeSubDomains' : ''}`
const HTTP_SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': ADMIN_HSTS_HEADER,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
}
const ADMIN_WEB_SECURITY_HEADERS = {
  ...HTTP_SECURITY_HEADERS,
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; connect-src 'self' https: wss:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"
}
const ADMIN_WEB_SHELL = fs.readFileSync(path.join(__dirname, 'admin-shell.html'), 'utf8')
const MINI_PROGRAM_QR_SCENE_MAX_LENGTH = 32
const MINI_PROGRAM_PAGE_MAX_LENGTH = 128
const LOGIN_SESSION_TTL_MS = 5 * 60 * 1000
const ADMIN_PASSWORD_SALT = process.env.ADMIN_PASSWORD_SALT || ''
const ADMIN_DUMMY_PASSWORD_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`
const WECHAT_MINIPROGRAM_QR_ENV_VERSION = process.env.WECHAT_MINIPROGRAM_QR_ENV_VERSION || 'release'
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_TENANT_SCOPE = 'single_store'
const ADMIN_ROLE_OPTIONS = ['super_admin', 'manager', 'viewer']
const ADMIN_AUDIT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const ADMIN_AUDIT_LOG_KEEP_LIMIT = 8000
const DEFAULT_HOME_CARDS = [
  { key: 'business_status', title: '营业状态', enabled: true, sort: 1 },
  { key: 'recommended_technicians', title: '推荐顾问', enabled: true, sort: 2 },
  { key: 'wellness_classroom', title: '企业资讯', enabled: true, sort: 3 }
]
const DEFAULT_FACILITIES = [
  { name: '门口停车', icon: 'logistics', enabled: true, sort: 1 },
  { name: '等候座椅', icon: 'friends-o', enabled: true, sort: 2 },
  { name: '资料预审指引', icon: 'records-o', enabled: true, sort: 3 }
]
const DEFAULT_BRANDING = {
  logo_file_id: '',
  watermark_enabled: true
}
const DEFAULT_RECOMMENDED_TECHNICIANS = []
// 动态运营配置只能使用这组预置模块。预约、我的预约、隐私、协议、注销等
// 用户权益与核心流程不在此列表内，不能被后台配置关闭或动态创建。
const DYNAMIC_OPERATION_MODULES = [
  { key: 'business_status', title: '营业状态', sort: 1 },
  { key: 'recommended_services', title: '推荐服务', sort: 2 },
  { key: 'recommended_technicians', title: '推荐顾问', sort: 3 },
  { key: 'articles', title: '企业资讯', sort: 4 }
]
const DYNAMIC_OPERATION_MODULE_KEYS = DYNAMIC_OPERATION_MODULES.map(item => item.key)
const DYNAMIC_CONFIG_ALLOWED_TOP_LEVEL_FIELDS = [
  'modules', 'announcement', 'recommended_services', 'recommended_technicians', 'facilities'
]
const DYNAMIC_CONFIG_MAX_RECOMMENDED_ITEMS = 8
const DYNAMIC_CONFIG_MAX_FACILITIES = 12
const DYNAMIC_CONFIG_MAX_ANNOUNCEMENT_TITLE_LENGTH = 48
const DYNAMIC_CONFIG_MAX_ANNOUNCEMENT_CONTENT_LENGTH = 240
const DYNAMIC_CONFIG_MAX_TECHNICIAN_NAME_LENGTH = 32
const DYNAMIC_CONFIG_MAX_TECHNICIAN_SPECIALTY_LENGTH = 120
const DYNAMIC_CONFIG_MAX_FACILITY_NAME_LENGTH = 24
const DYNAMIC_CONFIG_ALLOWED_FACILITY_ICONS = ['logistics', 'friends-o', 'records-o', 'shop-o', 'location-o']
const CONFIG_VERSION_KEEP_LIMIT = 30
const CONFIG_VERSION_QUERY_LIMIT = 100
const CONFIG_VERSION_PAGE_SIZE = 20
const CONFIG_VERSION_PAGE_SIZE_MAX = 50
const BUSINESS_CONFIG_PRIMARY_ID = 'primary'
const CONFIG_CONFLICT_CODE = 'CONFIG_CONFLICT'
const COMMISSION_SUMMARY_PAGE_SIZE = 100
let CURRENT_TRACE_ID = ''
const ADMIN_ACTION_PERMISSIONS = {
  super_admin: ['*'],
  manager: [
    'getServices', 'createService', 'updateService', 'deleteService',
    'getTechnicians', 'createTechnician', 'updateTechnician', 'toggleTechnicianStatus', 'deleteTechnician',
    'getCustomers', 'updateCustomer', 'deleteCustomer', 'toggleBlacklist',
    'getAppointments', 'getAppointmentDetail',
    'getHolidays', 'addHoliday', 'deleteHoliday',
    'getTechDaysOff', 'addTechDayOff', 'deleteTechDayOff',
    'getCommissions', 'getCommissionSummary',
    'getArticles', 'createArticle', 'updateArticle', 'toggleArticleStatus', 'deleteArticle',
    'updateConfig', 'getConfigDraft', 'saveConfigDraft', 'publishConfig', 'getConfigVersions', 'importHolidays',
    'getCurrentAdmin'
  ],
  viewer: [
    'getServices',
    'getTechnicians',
    'getCustomers',
    'getAppointments', 'getAppointmentDetail',
    'getHolidays',
    'getTechDaysOff',
    'getCommissions', 'getCommissionSummary',
    'getArticles',
    'getCurrentAdmin'
  ]
}

function isRoleValid(role) {
  return ADMIN_ROLE_OPTIONS.includes(role)
}

function getRolePermissions(role) {
  const normalizedRole = isRoleValid(role) ? role : ''
  return ADMIN_ACTION_PERMISSIONS[normalizedRole] || []
}

function normalizeAdminRole(role, fallback = '') {
  return isRoleValid(role) ? role : fallback
}

function parseIntLike(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

function parseDateLike(value) {
  if (value instanceof Date) {
    return value.getTime()
  }
  if (typeof value === 'number') {
    return value
  }
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizePagination(value, fallback = 1, max = 200) {
  const n = parseIntLike(value, fallback)
  if (n < 1) return fallback
  if (n > max) return max
  return n
}

function normalizeTraceId(traceId = '') {
  if (typeof traceId !== 'string') {
    return ''
  }

  return traceId.trim().slice(0, 64)
}

function createDeterministicDocumentId(prefix, parts) {
  const digest = crypto.createHash('sha256')
    .update(parts.map(item => String(item || '')).join('\u0000'))
    .digest('hex')
    .slice(0, 32)
  return `${prefix}_${digest}`
}

function createCodedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function withTraceId(value, traceId = CURRENT_TRACE_ID) {
  const finalTraceId = normalizeTraceId(traceId)
  if (!value || typeof value !== 'object') {
    return buildErrorResult('云函数返回格式异常', 'SESSION_CORRUPTED', finalTraceId)
  }

  if (!value.trace_id) {
    return {
      ...value,
      trace_id: finalTraceId
    }
  }

  return value
}

function normalizeMobile(value) {
  return String(value || '').trim()
}

function escapeRegExp(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeAppointmentStatus(status) {
  if (!status) {
    return ''
  }
  const value = String(status)
  return ['pending', 'completed', 'cancelled'].includes(value) ? value : ''
}

function isDateYMD(value) {
  const text = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false
  }
  const time = Date.parse(text)
  return Number.isFinite(time)
}

function isStartNoLaterThanEnd(startDate, endDate) {
  if (!isDateYMD(startDate) || !isDateYMD(endDate)) {
    return false
  }
  return Date.parse(startDate) <= Date.parse(endDate)
}

function normalizeAdminId(value) {
  const text = String(value || '').trim()
  if (!text || text.length > 64) {
    return ''
  }
  return text
}

function normalizeTextField(value, maxLen) {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }
  return text
}

function validateDateRangeFilter(startDate, endDate, requireBoth = false) {
  const start = String(startDate || '').trim()
  const end = String(endDate || '').trim()

  if (requireBoth && (!start || !end)) {
    return '日期范围参数不完整'
  }

  if (start && !isDateYMD(start)) {
    return '开始日期格式不合法'
  }

  if (end && !isDateYMD(end)) {
    return '结束日期格式不合法'
  }

  if (start && end && !isStartNoLaterThanEnd(start, end)) {
    return '日期范围参数不合法'
  }

  return ''
}

function normalizeScanSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    return ''
  }
  return sessionId.trim().toLowerCase()
}

function isValidScanSessionId(sessionId) {
  const normalized = normalizeScanSessionId(sessionId)
  return /^[a-z0-9]{32}$/.test(normalized)
}

async function expireLoginSession(sessionId, reason = '会话已过期') {
  const id = normalizeScanSessionId(sessionId)
  if (!isValidScanSessionId(id)) {
    return
  }

  try {
    await db.collection('login_sessions').doc(id).update({
      data: {
        status: 'expired',
        reject_reason: reason,
        expired_at: Date.now(),
        updated_at: Date.now()
      }
    })
  } catch (err) {
    logSafeError('更新扫码会话状态失败', err)
  }
}

async function cleanupExpiredLoginSessions(now = Date.now()) {
  try {
    const stale = await db.collection('login_sessions')
      .where({
        status: _.neq('expired'),
        expires_at: _.lt(now)
      })
      .limit(100)
      .get()

    if (!stale || !stale.data || stale.data.length === 0) {
      return
    }

    for (const item of stale.data) {
      await db.collection('login_sessions')
        .doc(item._id)
        .update({
          data: {
            status: 'expired',
            reject_reason: '会话已过期',
            expired_at: Date.now(),
            updated_at: Date.now()
          }
        })
        .catch(() => {})
    }
  } catch (err) {
    logSafeError('清理扫码会话失败', err)
  }
}

function normalizeLoginSessionEventId(sessionId) {
  return normalizeScanSessionId(sessionId)
}

function getScanSessionIdFromRequest(data) {
  const sessionId = normalizeLoginSessionEventId(data && data.session_id)
  if (!isValidScanSessionId(sessionId)) {
    return ''
  }
  return sessionId
}

function hasValidScanBrowserSecret(data, session = {}) {
  // Sessions created by the previous deployment expire within five minutes.
  if (!session.browser_secret_version) {
    const createdAt = Number(session.created_at || 0)
    const age = Date.now() - createdAt
    return createdAt > 0 && age >= 0 && age <= LOGIN_SESSION_TTL_MS
  }
  return verifyBrowserSecret(data && data.browser_secret, session.browser_secret_hash)
}

function buildErrorResult(message, errorCode = '', traceId = '') {
  return {
    code: -1,
    message,
    errorCode,
    error_code: errorCode,
    trace_id: normalizeTraceId(traceId || CURRENT_TRACE_ID)
  }
}

function buildSuccessResult(data) {
  return {
    code: 0,
    data,
    trace_id: normalizeTraceId(CURRENT_TRACE_ID)
  }
}

function getHealth() {
  return buildSuccessResult({
    status: 'ok',
    service: 'admin'
  })
}

function getSafeErrorCode(error) {
  const rawCode = String((error && (error.code || error.errCode || error.errcode)) || '')
  return /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : 'INTERNAL_ERROR'
}

function logSafeError(label, error) {
  console.error(label, {
    code: getSafeErrorCode(error),
    trace_id: normalizeTraceId(CURRENT_TRACE_ID)
  })
}

function extractAdminSessionInput(event = {}) {
  if (!event || typeof event !== 'object') {
    return {}
  }

  const raw = event.admin_session
  if (raw && typeof raw === 'object') {
    return {
      token: raw.token || raw.admin_token || '',
      role: raw.role || '',
      permissions: raw.permissions || raw.permission || []
    }
  }

  if (typeof raw === 'string') {
    return { token: raw }
  }

  return {
    token: event.admin_token || ''
  }
}

async function writeAdminAuditLog(adminAuth, action, options = {}) {
  try {
    const tenantScope = (adminAuth && adminAuth.tenant_scope) || DEFAULT_TENANT_SCOPE
    const now = Date.now()
    await db.collection('admin_audit_logs').add({
      data: {
        admin_user_id: adminAuth ? adminAuth.admin_user_id : '',
        admin_username: adminAuth ? adminAuth.username : '',
        role: adminAuth ? adminAuth.role : '',
        tenant_scope: tenantScope,
        action,
        target_type: options.targetType || '',
        target_id: options.targetId || '',
        status: options.status || 'success',
        changes: options.changes ? sanitizeAuditChanges(options.changes) : null,
        message: options.message || '',
        created_at: now
      }
    })

    await cleanupAdminAuditLogs(now).catch(() => {})
  } catch (err) {
    logSafeError('审计日志记录失败', err)
  }
}

async function cleanupAdminAuditLogs(now = Date.now()) {
  try {
    const expireBefore = now - ADMIN_AUDIT_LOG_RETENTION_MS
    const expired = await db.collection('admin_audit_logs')
      .where({ created_at: _.lt(expireBefore) })
      .limit(100)
      .get()

    if (expired && expired.data && expired.data.length > 0) {
      for (const item of expired.data) {
        await db.collection('admin_audit_logs').doc(item._id).remove().catch(() => {})
      }
    }

    const recent = await db.collection('admin_audit_logs')
      .orderBy('created_at', 'desc')
      .skip(ADMIN_AUDIT_LOG_KEEP_LIMIT)
      .get()

    if (recent && recent.data && recent.data.length > 0) {
      const cutoff = Number(recent.data[recent.data.length - 1].created_at || 0)
      if (cutoff > 0) {
        const tooMany = await db.collection('admin_audit_logs')
          .where({ created_at: _.lte(cutoff) })
          .limit(100)
          .get()
        if (tooMany && tooMany.data && tooMany.data.length > 0) {
          for (const item of tooMany.data) {
            await db.collection('admin_audit_logs').doc(item._id).remove().catch(() => {})
          }
        }
      }
    }
  } catch (err) {
    logSafeError('清理审计日志失败', err)
  }
}

async function invalidateAdminSessionsByUser(adminUserId, reason = '管理员账号变更') {
  if (!adminUserId) {
    return 0
  }

  try {
    const activeSessions = await db.collection('admin_sessions')
      .where({ admin_user_id: adminUserId, status: 'active' })
      .limit(100)
      .get()

    if (!activeSessions || !activeSessions.data || activeSessions.data.length === 0) {
      return 0
    }

    const now = Date.now()
    let count = 0
    for (const item of activeSessions.data) {
      await db.collection('admin_sessions')
        .doc(item._id)
        .update({
          data: {
            status: 'logged_out',
            logout_reason: reason,
            last_accessed_at: now,
            updated_at: now
          }
        })
        .catch(() => {})
      count += 1
    }

    return count
  } catch (err) {
    logSafeError('失效管理员会话失败', err)
    return 0
  }
}

function canAdminAccessAction(role, action) {
  const normalizedRole = normalizeAdminRole(role, '')
  const allowedActions = ADMIN_ACTION_PERMISSIONS[normalizedRole] || []
  return allowedActions.includes('*') || allowedActions.includes(action)
}

function sanitizeAdminUser(user = {}) {
  const safeUser = { ...user }
  delete safeUser.password_hash
  safeUser.role = normalizeAdminRole(safeUser.role, '')
  safeUser.status = safeUser.status || 'active'
  return safeUser
}

function getWechatMiniProgramConfig() {
  const appid = process.env.WECHAT_APPID || process.env.WECHAT_APP_ID || process.env.WX_APPID || process.env.WX_APP_ID
  const appSecret = process.env.WECHAT_APPSECRET || process.env.WECHAT_APP_SECRET || process.env.WX_APPSECRET || process.env.WX_APP_SECRET
  return { appid, appSecret }
}

function isWechatQrConfigured() {
  const { appid, appSecret } = getWechatMiniProgramConfig()
  return Boolean(String(appid || '').trim() && String(appSecret || '').trim())
}

async function requestWechatJson(url, method, data, headers = {}) {
  const hasBody = data && method !== 'GET'
  const body = hasBody ? JSON.stringify(data) : ''
  const requestUrl = new URL(url)
  const timeoutMs = REQUEST_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let req = null
    const timer = setTimeout(() => {
      if (req) {
        req.destroy()
      }
      const error = new Error('微信 API 请求超时')
      error.code = 'WECHAT_API_TIMEOUT'
      reject(error)
    }, timeoutMs)

    req = https.request(
      {
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(hasBody ? { 'Content-Length': Buffer.from(body).length } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          clearTimeout(timer)
          const responseBody = Buffer.concat(chunks)
          const contentType = (res.headers['content-type'] || '').toLowerCase()

          if (contentType.includes('application/json') || contentType.includes('text/plain')) {
            let payload
            try {
              payload = JSON.parse(responseBody.toString('utf8') || '{}')
            } catch (err) {
              payload = { raw: responseBody.toString('utf8') }
            }
            if (payload && typeof payload.errcode !== 'undefined' && Number(payload.errcode) !== 0) {
              const msg = payload.errmsg ? payload.errmsg : `HTTP ${res.statusCode}`
              reject(new Error(`微信 API 调用失败: ${msg}`))
              return
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
              const msg = payload && payload.errmsg ? payload.errmsg : `HTTP ${res.statusCode}`
              reject(new Error(`微信 API 调用失败: ${msg}`))
              return
            }
            resolve({ body: payload, headers: res.headers, contentType })
            return
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`微信 API 调用失败: HTTP ${res.statusCode}`))
            return
          }

          resolve({ body: responseBody, headers: res.headers, contentType })
        })
      }
    )

    req.on('error', (err) => {
      clearTimeout(timer)
      const error = new Error('微信 API 网络请求失败')
      error.code = getSafeErrorCode(err)
      reject(error)
    })
    if (hasBody) req.write(body)
    req.end()
  })
}

async function getWechatAccessToken() {
  const now = Date.now()
  if (wechatTokenCache.token && wechatTokenCache.expireAt > now + 60 * 1000) {
    return wechatTokenCache.token
  }

  const { appid, appSecret } = getWechatMiniProgramConfig()
  if (!appid || !appSecret) {
    throw new Error('缺少微信小程序 APPID/APPSECRET 配置，无法生成小程序码')
  }

  const tokenApi = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(appSecret)}`
  const tokenRes = await requestWechatJson(tokenApi, 'GET')

  if (!tokenRes.body || !tokenRes.body.access_token) {
    throw new Error('微信 token 返回异常')
  }

  const expireInSeconds = Number(tokenRes.body.expires_in || 7200)
  wechatTokenCache.token = tokenRes.body.access_token
  wechatTokenCache.expireAt = now + (Math.max(120, expireInSeconds - 120) * 1000)
  return wechatTokenCache.token
}

function getMiniProgramPagePath() {
  const configuredPath = process.env.WECHAT_MINIPROGRAM_LOGIN_PAGE
    || 'pages/scan-confirm/scan-confirm'
  const normalized = (configuredPath || '').replace(/^\//, '')

  if (!normalized || normalized.length > MINI_PROGRAM_PAGE_MAX_LENGTH) {
    return 'pages/scan-confirm/scan-confirm'
  }

  return normalized
}

function getScanSessionUrl(sessionId) {
  const scene = normalizeMiniProgramScene(sessionId)
  const page = getMiniProgramPagePath()
  if (!scene || !page) {
    return ''
  }

  return `${page}?session_id=${encodeURIComponent(scene)}`
}

function buildScanSessionResponse(sessionId, payload = {}) {
  const sessionExpireAt = Number(payload.expires_at || payload.session_expire_at || 0)
  return {
    ...payload,
    session_id: sessionId,
    confirm_url: getScanSessionUrl(sessionId),
    type: payload.type || 'admin_login',
    status: payload.status || 'pending',
    session_expire_at: sessionExpireAt,
    expires_at: sessionExpireAt
  }
}

function normalizeMiniProgramScene(sessionId) {
  if (typeof sessionId !== 'string') return ''
  if (sessionId.length > MINI_PROGRAM_QR_SCENE_MAX_LENGTH) return ''
  return sessionId
}

function createCallerBoundLoginSessionId(context = {}) {
  const callerId = String(process.env.TCB_UUID || getCloudbaseUidFromContext(context) || '').trim()
  return createCallerBoundSessionId(callerId)
}

exports.main = async (event, context) => {
  if (event && event.httpMethod) {
    return handleHttpAccess(event)
  }

  const { action: rawAction, data = {} } = event || {}
  const action = String(rawAction || '')
  CURRENT_TRACE_ID = normalizeTraceId(event && (event.trace_id || event.traceId || ''))

  try {
    // 受保护的 action 需要校验管理员会话和角色权限
    const protectedActions = [
      'getCurrentAdmin',
      'logout',
      'getAdminAuditLogs',
      'getServices', 'createService', 'updateService', 'deleteService',
      'getTechnicians', 'createTechnician', 'updateTechnician', 'toggleTechnicianStatus', 'deleteTechnician',
      'getCustomers', 'updateCustomer', 'deleteCustomer', 'toggleBlacklist',
      'getAppointments', 'getAppointmentDetail',
      'addHoliday', 'deleteHoliday',
      'getTechDaysOff', 'addTechDayOff', 'deleteTechDayOff',
      'getCommissions', 'getCommissionSummary',
      'getArticles', 'createArticle', 'updateArticle', 'toggleArticleStatus', 'deleteArticle',
      'updateConfig', 'getConfigDraft', 'saveConfigDraft', 'publishConfig', 'getConfigVersions', 'rollbackConfig', 'importHolidays',
      'initializeProductionContent',
      'getAdminUsers', 'addAdminUser', 'updateAdminUser', 'removeAdminUser', 'createAdminBindSession'
    ]

    let adminAuth = null

    if (protectedActions.includes(action)) {
      const authResult = await ensureAdminPermission(event, action)
      if (!authResult.ok) {
        return authResult.error
      }
      adminAuth = authResult.auth
    }

    const result = await (async () => {
      switch (action) {
      case 'health':
        return getHealth()

      // 获取营业配置
      case 'getConfig':
        return await getConfig(event)
      case 'getConfigDraft':
        return await getConfigDraft(adminAuth)
      case 'createAppointmentQrCode':
        return await createAppointmentQrCode(data)

      // 管理员登录
      case 'verifyAdminPassword':
        return await verifyAdminPassword(data)

      // 更新营业配置
      case 'updateConfig':
        return await updateConfig(adminAuth, data)
      case 'saveConfigDraft':
        return await saveConfigDraft(adminAuth, data)
      case 'publishConfig':
        return await publishConfig(adminAuth)
      case 'getConfigVersions':
        return await getConfigVersions(adminAuth, data)
      case 'rollbackConfig':
        return await rollbackConfig(adminAuth, data)
      case 'initializeProductionContent':
        return await initializeProductionContent(adminAuth)

      // 服务管理
      case 'getServices':
        return await getServices()
      case 'createService':
        return await createService(adminAuth, data)
      case 'updateService':
        return await updateService(adminAuth, data)
      case 'deleteService':
        return await deleteService(adminAuth, data)

      // 顾问管理
      case 'getTechnicians':
        return await getTechnicians()
      case 'createTechnician':
        return await createTechnician(adminAuth, data)
      case 'updateTechnician':
        return await updateTechnician(adminAuth, data)
      case 'toggleTechnicianStatus':
        return await toggleTechnicianStatus(adminAuth, data)
      case 'deleteTechnician':
        return await deleteTechnician(adminAuth, data)

      // 客户管理
      case 'getCustomers':
        return await getCustomers(adminAuth, data)
      case 'updateCustomer':
        return await updateCustomer(adminAuth, data)
      case 'deleteCustomer':
        return await deleteCustomer(adminAuth, data)
      case 'toggleBlacklist':
        return await toggleBlacklist(adminAuth, data)

      // 预约管理
      case 'getAppointments':
        return await getAdminAppointments(adminAuth, data)
      case 'getAppointmentDetail':
        return await getAppointmentDetail(adminAuth, data)

      // 休息管理
      case 'getHolidays':
        return await getHolidays(data)
      case 'addHoliday':
        return await addHoliday(adminAuth, data)
      case 'deleteHoliday':
        return await deleteHoliday(adminAuth, data)
      case 'getTechDaysOff':
        return await getTechDaysOff()
      case 'addTechDayOff':
        return await addTechDayOff(adminAuth, data)
      case 'deleteTechDayOff':
        return await deleteTechDayOff(adminAuth, data)

      // 提成统计
      case 'getCommissions':
        return await getCommissions(data)
      case 'getCommissionSummary':
        return await getCommissionSummary(data)

      // 文章管理
      case 'getArticles':
        return await getArticles()
      case 'createArticle':
        return await createArticle(adminAuth, data)
      case 'updateArticle':
        return await updateArticle(adminAuth, data)
      case 'toggleArticleStatus':
        return await toggleArticleStatus(adminAuth, data)
      case 'deleteArticle':
        return await deleteArticle(adminAuth, data)

      // 导入法定节假日
      case 'importHolidays':
        return await importHolidays()

      // 管理员账号管理
      case 'getCurrentAdmin':
        return await getCurrentAdmin(adminAuth)
      case 'getAdminAuditLogs':
        return await getAdminAuditLogs(adminAuth, data)
      case 'getAdminUsers':
        return await getAdminUsers(adminAuth)
      case 'addAdminUser':
        return await addAdminUser(adminAuth, data)
      case 'updateAdminUser':
        return await updateAdminUser(adminAuth, data)
      case 'removeAdminUser':
        return await removeAdminUser(adminAuth, data)
      case 'logout':
        return await logoutAdmin(adminAuth)

      // 扫码登录
      case 'createSession':
        return await createLoginSession(data, context)
      case 'createLoginSession':
        return await createLoginSession(data, context)
      case 'createAdminBindSession':
        return await createAdminBindSession(data)
      case 'confirmLoginSession':
        return await confirmLoginSession(data)
      case 'checkLoginSession':
        return await checkLoginSession(data)
      case 'scanLogin':
        return await scanLogin(data)

      default:
        return buildErrorResult('未知操作', 'SESSION_CORRUPTED')
      }
    })()

    return withTraceId(result)
  } catch (err) {
    logSafeError(`操作 ${action} 失败`, err)
    return buildErrorResult('操作失败，请稍后重试', 'SESSION_CORRUPTED')
  } finally {
    CURRENT_TRACE_ID = ''
  }
}

function handleHttpAccess(event) {
  const query = event.queryStringParameters || {}
  const sessionId = query.session_id || ''

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: {
        ...HTTP_SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ message: 'Method Not Allowed' })
    }
  }

  if (query.action === 'health') {
    return {
      statusCode: 200,
      headers: {
        ...HTTP_SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ status: 'ok', service: 'admin' })
    }
  }

  if (!sessionId) {
    return {
      statusCode: 200,
      headers: {
        ...ADMIN_WEB_SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8'
      },
      body: ADMIN_WEB_SHELL
    }
  }

  if (!/^[a-z0-9]{32}$/.test(sessionId)) {
    return {
      statusCode: 400,
      headers: {
        ...HTTP_SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8'
      },
      body: '<!doctype html><html><head><meta charset="utf-8"><title>扫码登录</title></head><body><p>无效的登录二维码，请返回管理后台刷新后重试。</p></body></html>'
    }
  }

  return {
    statusCode: 200,
    headers: {
      ...HTTP_SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8'
    },
    body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>扫码登录</title></head><body><p>请使用微信扫描该二维码，并在小程序内确认登录。</p></body></html>'
  }
}

function generateToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('hex')
}

function hashLegacyAdminPassword(password) {
  return crypto
    .createHash('sha256')
    .update(`${ADMIN_PASSWORD_SALT}:${String(password || '')}`)
    .digest('hex')
}

function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16)
  const derivedKey = crypto.scryptSync(String(password || ''), salt, 64)
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`
}

function verifyPasswordHash(password, storedHash) {
  const normalizedHash = String(storedHash || '')
  const parts = normalizedHash.split('$')
  if (parts.length === 3 && parts[0] === 'scrypt') {
    try {
      const salt = Buffer.from(parts[1], 'hex')
      const expected = Buffer.from(parts[2], 'hex')
      const actual = crypto.scryptSync(String(password || ''), salt, expected.length)
      return { valid: expected.length > 0 && crypto.timingSafeEqual(actual, expected), legacy: false }
    } catch (err) {
      return { valid: false, legacy: false }
    }
  }

  if (!ADMIN_PASSWORD_SALT || !/^[a-f0-9]{64}$/i.test(normalizedHash)) {
    return { valid: false, legacy: false }
  }
  const actualLegacy = Buffer.from(hashLegacyAdminPassword(password), 'hex')
  const expectedLegacy = Buffer.from(normalizedHash, 'hex')
  const valid = actualLegacy.length === expectedLegacy.length &&
    actualLegacy.length > 0 && crypto.timingSafeEqual(actualLegacy, expectedLegacy)
  return { valid, legacy: valid }
}

function isStrongAdminPassword(password) {
  const value = String(password || '')
  return value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value)
}

async function createAdminSession(data = {}) {
  const token = generateToken()
  const now = Date.now()
  const role = normalizeAdminRole(data.role, '')
  if (!role) {
    throw new Error('管理员角色异常')
  }
  const permissions = getRolePermissions(role)
  const tenantScope = DEFAULT_TENANT_SCOPE
  const adminUserId = data.admin_user_id || ''
  const sessionExpireAt = now + ADMIN_SESSION_TTL_MS

  if (adminUserId) {
    await invalidateAdminSessionsByUser(adminUserId, '重新登录')
  }

  await db.collection('admin_sessions').add({
    data: {
      _id: token,
      admin_user_id: adminUserId,
      username: data.username || '',
      role,
      permissions,
      tenant_scope: tenantScope,
      openid: data.openid || '',
      login_method: data.login_method || 'password',
      status: 'active',
      created_at: now,
      session_expire_at: sessionExpireAt,
      updated_at: now,
      last_login_at: now,
      expires_at: sessionExpireAt
    }
  })

  if (adminUserId) {
    await db.collection('admin_users').doc(adminUserId).update({
      data: {
        last_login_at: now,
        last_login_method: data.login_method || 'password',
        openid: data.openid || '',
        updated_at: now
      }
    }).catch(() => {})
  }

  return token
}

async function ensureAdminPermission(event, action) {
  const adminAuth = await getAdminAuth(event)
  if (!adminAuth) {
    return {
      ok: false,
      error: buildErrorResult('身份验证失败，请重新登录', 'SESSION_EXPIRED')
    }
  }

  if (!isRoleValid(adminAuth.role)) {
    return {
      ok: false,
      error: buildErrorResult('账号角色异常，请重新登录', 'ROLE_MISMATCH')
    }
  }

  if (!canAdminAccessAction(adminAuth.role, action)) {
    return {
      ok: false,
      error: buildErrorResult('当前账号无权限访问该功能', 'INSUFFICIENT_PERMISSION')
    }
  }

  return { ok: true, auth: adminAuth }
}

async function getAdminAuth(event = {}) {
  const sessionInput = extractAdminSessionInput(event)
  if (!sessionInput || !sessionInput.token) {
    return null
  }

  try {
    const sessionRes = await db.collection('admin_sessions').doc(sessionInput.token).get()
    const session = sessionRes.data
    if (!session) {
      return null
    }

    if (session.status && session.status !== 'active') {
      return null
    }

    const now = Date.now()
    const resolvedExpireAt = Number(session.expires_at || session.session_expire_at || 0)
    if (!resolvedExpireAt || now > resolvedExpireAt) {
      await db.collection('admin_sessions').doc(sessionInput.token).update({
        data: {
          status: 'expired'
        }
      }).catch(() => {})
      return null
    }

    const adminUserId = session.admin_user_id || ''
    let role = normalizeAdminRole(session.role, '')
    let username = session.username || ''
    let openid = session.openid || ''

    if (adminUserId) {
      const adminUserRes = await db.collection('admin_users').doc(adminUserId).get()
      if (!adminUserRes.data || (adminUserRes.data.status && adminUserRes.data.status !== 'active')) {
        return null
      }
      const adminRole = adminUserRes.data.role
      if (!isRoleValid(adminRole)) {
        return null
      }
      role = normalizeAdminRole(adminRole, '')
      username = adminUserRes.data.username || username
      openid = adminUserRes.data.openid || openid
    } else if (!isRoleValid(role)) {
      return null
    }

    const permissions = getRolePermissions(role)
    const resolvedTenantScope = session.tenant_scope || DEFAULT_TENANT_SCOPE
    // 当前数据模型是单门店；拒绝与全局集合查询不一致的伪多租户会话。
    if (resolvedTenantScope !== DEFAULT_TENANT_SCOPE) {
      return null
    }
    const resolvedLastLoginAt = Number(session.last_login_at || session.updated_at || session.created_at || now)

    if (session.role !== role || JSON.stringify(session.permissions || []) !== JSON.stringify(permissions)) {
      db.collection('admin_sessions').doc(sessionInput.token).update({
        data: {
          role,
          permissions,
          tenant_scope: resolvedTenantScope,
          updated_at: now
        }
      }).catch(() => {})
    } else {
      db.collection('admin_sessions').doc(sessionInput.token).update({
        data: { last_accessed_at: now, updated_at: now }
      }).catch(() => {})
    }

    return {
      token: sessionInput.token,
      admin_user_id: adminUserId,
      admin_id: adminUserId,
      username,
      role,
      permissions,
      admin_permissions: permissions,
      tenant_scope: resolvedTenantScope,
      openid,
      session_expire_at: resolvedExpireAt,
      last_login_at: resolvedLastLoginAt,
      status: session.status || 'active',
      created_at: session.created_at || 0,
      updated_at: session.updated_at || 0
    }
  } catch (err) {
    logSafeError('会话校验失败', err)
    return null
  }
}

async function validateAdminAuth(event = {}) {
  return Boolean(await getAdminAuth(event))
}

// ==================== 营业配置 ====================

function cleanConfigText(value, fallback = '', max = 40) {
  const text = String(value || fallback || '').trim()
  return text.slice(0, max)
}

function normalizeEnabled(value) {
  return value !== false
}

function normalizeHomeCards(input) {
  const source = Array.isArray(input) ? input : []
  return DEFAULT_HOME_CARDS.map((item) => {
    const saved = source.find(candidate => candidate && candidate.key === item.key) || {}
    return {
      key: item.key,
      title: cleanConfigText(saved.title, item.title, 24),
      enabled: normalizeEnabled(saved.enabled),
      sort: parseIntLike(saved.sort, item.sort)
    }
  }).sort((a, b) => a.sort - b.sort)
}

function normalizeFacilities(input) {
  if (input !== undefined && !Array.isArray(input)) {
    return DEFAULT_FACILITIES
  }
  const source = input === undefined ? DEFAULT_FACILITIES : input
  return source.slice(0, 12).map((item, index) => ({
    name: cleanConfigText(item && item.name, '', 16),
    icon: cleanConfigText(item && item.icon, 'shop-o', 24),
    enabled: normalizeEnabled(item && item.enabled),
    sort: parseIntLike(item && item.sort, index + 1)
  })).filter(item => item.name).sort((a, b) => a.sort - b.sort)
}

function normalizeRecommendedTechnicians(input) {
  if (input !== undefined && !Array.isArray(input)) {
    return DEFAULT_RECOMMENDED_TECHNICIANS
  }
  const source = input === undefined ? DEFAULT_RECOMMENDED_TECHNICIANS : input
  return source.slice(0, 12).map((item, index) => ({
    name: cleanConfigText(item && item.name, '', 16),
    specialty: cleanConfigText(item && item.specialty, '擅长企业服务', 32),
    enabled: normalizeEnabled(item && item.enabled),
    sort: parseIntLike(item && item.sort, index + 1)
  })).filter(item => item.name).sort((a, b) => a.sort - b.sort)
}

function normalizeBranding(input) {
  const source = input && typeof input === 'object' ? input : DEFAULT_BRANDING
  const logoFileId = String(source.logo_file_id || '').trim()
  return {
    logo_file_id: logoFileId.startsWith('cloud://') ? logoFileId.slice(0, 512) : '',
    watermark_enabled: source.watermark_enabled !== false
  }
}

function isConfigPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasConfigOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key)
}

function getUnknownConfigField(value, allowedFields) {
  if (!isConfigPlainObject(value)) {
    return ''
  }
  return Object.keys(value).find(key => !allowedFields.includes(key)) || ''
}

function cloneOperationConfig(value) {
  return JSON.parse(JSON.stringify(value))
}

function createDefaultOperationConfig() {
  return {
    modules: DYNAMIC_OPERATION_MODULES.map(item => ({
      key: item.key,
      title: item.title,
      enabled: true,
      sort: item.sort
    })),
    announcement: {
      enabled: false,
      title: '公告',
      content: '',
      sort: 1
    },
    recommended_services: [],
    recommended_technicians: [],
    facilities: DEFAULT_FACILITIES.map((item, index) => ({
      name: item.name,
      icon: item.icon,
      enabled: item.enabled !== false,
      sort: index + 1
    }))
  }
}

function normalizeOperationSort(value, fallback, fieldName, strict) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: fallback }
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 99) {
    if (strict) {
      return { ok: false, error: fieldName + ' 必须是 1 到 99 的整数' }
    }
    return { ok: true, value: fallback }
  }
  return { ok: true, value: parsed }
}

function normalizeOperationText(value, maxLength, fieldName, strict) {
  if (value === undefined || value === null) {
    return { ok: true, value: '' }
  }
  if (typeof value !== 'string') {
    if (strict) {
      return { ok: false, error: fieldName + ' 必须是文本' }
    }
    value = String(value)
  }

  const text = value.trim()
  if (text.length > maxLength) {
    if (strict) {
      return { ok: false, error: fieldName + ' 不能超过 ' + maxLength + ' 个字符' }
    }
    return { ok: true, value: text.slice(0, maxLength) }
  }
  if (/[<>]/.test(text)) {
    if (strict) {
      return { ok: false, error: fieldName + ' 只能填写纯文本' }
    }
    return { ok: true, value: text.replace(/[<>]/g, '') }
  }
  return { ok: true, value: text }
}

function normalizeOperationReferenceId(value, fieldName, strict) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: '' }
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) {
    if (strict) {
      return { ok: false, error: fieldName + ' 格式不合法' }
    }
    return { ok: true, value: '' }
  }
  return { ok: true, value: value.trim() }
}

function normalizeOperationModules(input, strict) {
  const defaults = createDefaultOperationConfig().modules
  if (input === undefined || input === null) {
    return { ok: true, value: defaults }
  }
  if (!Array.isArray(input)) {
    return strict
      ? { ok: false, error: 'modules 必须是数组' }
      : { ok: true, value: defaults }
  }
  if (input.length > DYNAMIC_OPERATION_MODULES.length) {
    return strict
      ? { ok: false, error: 'modules 数量超出限制' }
      : { ok: true, value: defaults }
  }

  const savedByKey = {}
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isConfigPlainObject(item)) {
      if (strict) {
        return { ok: false, error: 'modules[' + index + '] 必须是对象' }
      }
      continue
    }
    const unknownField = getUnknownConfigField(item, ['key', 'enabled', 'sort'])
    if (unknownField) {
      if (strict) {
        return { ok: false, error: 'modules[' + index + '] 包含未允许字段: ' + unknownField }
      }
      continue
    }
    const key = String(item.key || '').trim()
    if (!DYNAMIC_OPERATION_MODULE_KEYS.includes(key)) {
      if (strict) {
        return { ok: false, error: '不允许配置模块: ' + key }
      }
      continue
    }
    if (savedByKey[key]) {
      if (strict) {
        return { ok: false, error: 'modules 中存在重复模块: ' + key }
      }
      continue
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      if (strict) {
        return { ok: false, error: 'modules[' + index + '].enabled 必须是布尔值' }
      }
      continue
    }
    const defaultModule = DYNAMIC_OPERATION_MODULES.find(candidate => candidate.key === key)
    const sortResult = normalizeOperationSort(item.sort, defaultModule.sort, 'modules[' + index + '].sort', strict)
    if (!sortResult.ok) {
      return sortResult
    }
    savedByKey[key] = {
      enabled: item.enabled !== false,
      sort: sortResult.value
    }
  }

  return {
    ok: true,
    value: DYNAMIC_OPERATION_MODULES.map(item => {
      const saved = savedByKey[item.key] || {}
      return {
        key: item.key,
        title: item.title,
        enabled: saved.enabled !== false,
        sort: saved.sort || item.sort
      }
    }).sort((a, b) => a.sort - b.sort)
  }
}

function normalizeOperationAnnouncement(input, strict) {
  const defaults = createDefaultOperationConfig().announcement
  if (input === undefined || input === null) {
    return { ok: true, value: defaults }
  }
  if (!isConfigPlainObject(input)) {
    return strict
      ? { ok: false, error: 'announcement 必须是对象' }
      : { ok: true, value: defaults }
  }
  const unknownField = getUnknownConfigField(input, ['enabled', 'title', 'content', 'sort'])
  if (unknownField) {
    return strict
      ? { ok: false, error: 'announcement 包含未允许字段: ' + unknownField }
      : { ok: true, value: defaults }
  }
  const titleResult = normalizeOperationText(
    input.title,
    DYNAMIC_CONFIG_MAX_ANNOUNCEMENT_TITLE_LENGTH,
    'announcement.title',
    strict
  )
  if (!titleResult.ok) {
    return titleResult
  }
  const contentResult = normalizeOperationText(
    input.content,
    DYNAMIC_CONFIG_MAX_ANNOUNCEMENT_CONTENT_LENGTH,
    'announcement.content',
    strict
  )
  if (!contentResult.ok) {
    return contentResult
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return strict ? { ok: false, error: 'announcement.enabled 必须是布尔值' } : { ok: true, value: defaults }
  }
  const sortResult = normalizeOperationSort(input.sort, 1, 'announcement.sort', strict)
  if (!sortResult.ok) return sortResult
  return {
    ok: true,
    value: {
      enabled: input.enabled === true,
      title: titleResult.value,
      content: contentResult.value,
      sort: sortResult.value
    }
  }
}

function normalizeRecommendedServices(input, strict) {
  if (input === undefined || input === null) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(input)) {
    return strict
      ? { ok: false, error: 'recommended_services 必须是数组' }
      : { ok: true, value: [] }
  }
  if (input.length > DYNAMIC_CONFIG_MAX_RECOMMENDED_ITEMS) {
    return strict
      ? { ok: false, error: 'recommended_services 数量不能超过 ' + DYNAMIC_CONFIG_MAX_RECOMMENDED_ITEMS }
      : { ok: true, value: [] }
  }

  const usedIds = new Set()
  const output = []
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isConfigPlainObject(item)) {
      if (strict) {
        return { ok: false, error: 'recommended_services[' + index + '] 必须是对象' }
      }
      continue
    }
    const unknownField = getUnknownConfigField(item, ['service_id', 'enabled', 'sort'])
    if (unknownField) {
      if (strict) {
        return { ok: false, error: 'recommended_services[' + index + '] 包含未允许字段: ' + unknownField }
      }
      continue
    }
    const idResult = normalizeOperationReferenceId(item.service_id, 'recommended_services[' + index + '].service_id', strict)
    if (!idResult.ok || !idResult.value) {
      if (strict) {
        return idResult.ok
          ? { ok: false, error: 'recommended_services[' + index + '].service_id 不能为空' }
          : idResult
      }
      continue
    }
    if (usedIds.has(idResult.value)) {
      if (strict) {
        return { ok: false, error: 'recommended_services 中存在重复服务' }
      }
      continue
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      if (strict) {
        return { ok: false, error: 'recommended_services[' + index + '].enabled 必须是布尔值' }
      }
      continue
    }
    const sortResult = normalizeOperationSort(item.sort, index + 1, 'recommended_services[' + index + '].sort', strict)
    if (!sortResult.ok) {
      return sortResult
    }
    usedIds.add(idResult.value)
    output.push({
      service_id: idResult.value,
      enabled: item.enabled !== false,
      sort: sortResult.value
    })
  }
  return { ok: true, value: output.sort((a, b) => a.sort - b.sort) }
}

function normalizeRecommendedTechnicianReferences(input, strict) {
  if (input === undefined || input === null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return strict ? { ok: false, error: 'recommended_technicians 必须是数组' } : { ok: true, value: [] }
  if (input.length > DYNAMIC_CONFIG_MAX_RECOMMENDED_ITEMS) {
    return strict ? { ok: false, error: 'recommended_technicians 数量不能超过 ' + DYNAMIC_CONFIG_MAX_RECOMMENDED_ITEMS } : { ok: true, value: [] }
  }
  const usedIds = new Set()
  const output = []
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isConfigPlainObject(item)) {
      if (strict) return { ok: false, error: `recommended_technicians[${index}] 必须是对象` }
      continue
    }
    const unknown = getUnknownConfigField(item, ['technician_id', 'enabled', 'sort'])
    if (unknown) {
      if (strict) return { ok: false, error: `recommended_technicians[${index}] 包含未允许字段: ${unknown}` }
      continue
    }
    const id = normalizeOperationReferenceId(item.technician_id, `recommended_technicians[${index}].technician_id`, strict)
    if (!id.ok || !id.value || usedIds.has(id.value)) {
      if (strict) return { ok: false, error: `recommended_technicians[${index}].technician_id 不合法或重复` }
      continue
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      if (strict) return { ok: false, error: `recommended_technicians[${index}].enabled 必须是布尔值` }
      continue
    }
    const sort = normalizeOperationSort(item.sort, index + 1, `recommended_technicians[${index}].sort`, strict)
    if (!sort.ok) return sort
    usedIds.add(id.value)
    output.push({ technician_id: id.value, enabled: item.enabled !== false, sort: sort.value })
  }
  return { ok: true, value: output.sort((a, b) => a.sort - b.sort) }
}

function normalizeOperationFacilities(input, strict) {
  if (input === undefined || input === null) return { ok: true, value: cloneOperationConfig(DEFAULT_FACILITIES) }
  if (!Array.isArray(input)) return strict ? { ok: false, error: 'facilities 必须是数组' } : { ok: true, value: cloneOperationConfig(DEFAULT_FACILITIES) }
  if (input.length > DYNAMIC_CONFIG_MAX_FACILITIES) {
    return strict ? { ok: false, error: 'facilities 数量不能超过 ' + DYNAMIC_CONFIG_MAX_FACILITIES } : { ok: true, value: cloneOperationConfig(DEFAULT_FACILITIES) }
  }
  const output = []
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isConfigPlainObject(item)) {
      if (strict) return { ok: false, error: `facilities[${index}] 必须是对象` }
      continue
    }
    const unknown = getUnknownConfigField(item, ['name', 'icon', 'enabled', 'sort'])
    if (unknown) {
      if (strict) return { ok: false, error: `facilities[${index}] 包含未允许字段: ${unknown}` }
      continue
    }
    const name = normalizeOperationText(item.name, DYNAMIC_CONFIG_MAX_FACILITY_NAME_LENGTH, `facilities[${index}].name`, strict)
    if (!name.ok) return name
    if (!name.value) continue
    const icon = String(item.icon || 'shop-o')
    if (!DYNAMIC_CONFIG_ALLOWED_FACILITY_ICONS.includes(icon)) {
      if (strict) return { ok: false, error: `facilities[${index}].icon 不在允许范围` }
      continue
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      if (strict) return { ok: false, error: `facilities[${index}].enabled 必须是布尔值` }
      continue
    }
    const sort = normalizeOperationSort(item.sort, index + 1, `facilities[${index}].sort`, strict)
    if (!sort.ok) return sort
    output.push({ name: name.value, icon, enabled: item.enabled !== false, sort: sort.value })
  }
  return { ok: true, value: output.sort((a, b) => a.sort - b.sort) }
}

function normalizeOperationConfig(input, strict = false) {
  const source = isConfigPlainObject(input) ? input : {}
  if (strict) {
    const unknown = getUnknownConfigField(source, DYNAMIC_CONFIG_ALLOWED_TOP_LEVEL_FIELDS)
    if (unknown) return { ok: false, error: '运营配置包含未允许字段: ' + unknown }
  }
  const modules = normalizeOperationModules(source.modules, strict)
  const announcement = normalizeOperationAnnouncement(source.announcement, strict)
  const services = normalizeRecommendedServices(source.recommended_services, strict)
  const technicians = normalizeRecommendedTechnicianReferences(source.recommended_technicians, strict)
  const facilities = normalizeOperationFacilities(source.facilities, strict)
  for (const result of [modules, announcement, services, technicians, facilities]) {
    if (!result.ok) return result
  }
  return { ok: true, value: {
    modules: modules.value,
    announcement: announcement.value,
    recommended_services: services.value,
    recommended_technicians: technicians.value,
    facilities: facilities.value
  } }
}

function withDisplayConfigDefaults(config = {}) {
  return {
    ...config,
    branding: normalizeBranding(config.branding),
    home_cards: normalizeHomeCards(config.home_cards),
    facilities: normalizeFacilities(config.facilities),
    recommended_technicians: normalizeRecommendedTechnicians(config.recommended_technicians)
  }
}

function createDefaultBusinessConfig() {
  return {
    store: {
      name: '山东营生科贸有限公司',
      phone: '',
      address: '',
      latitude: null,
      longitude: null
    },
    schedule: {
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
      7: []
    },
    slot_interval: 30, holidays: [], max_advance_days: 14,
    branding: normalizeBranding(), home_cards: normalizeHomeCards(),
    facilities: normalizeFacilities(), recommended_technicians: normalizeRecommendedTechnicians()
  }
}

function getLegacyBusinessFields(document = {}) {
  const {
    _id, admin_password, draft, published, draft_updated_at, draft_updated_by,
    published_at, published_by, published_version,
    production_seed_version, production_seed_initialized_at, production_seed_initialized_by,
    ...legacy
  } = document || {}
  return withDisplayConfigDefaults({ ...createDefaultBusinessConfig(), ...legacy })
}

function getPublishedOperationConfig(document = {}) {
  const source = isConfigPlainObject(document.published) ? document.published : {
    modules: document.modules,
    announcement: document.announcement,
    recommended_services: document.recommended_services,
    recommended_technicians: [],
    facilities: document.facilities
  }
  return normalizeOperationConfig(source, false).value
}

async function getOrCreateBusinessConfigDocument() {
  const collection = db.collection('business_config')
  const primary = await collection.where({ _id: BUSINESS_CONFIG_PRIMARY_ID }).limit(1).get()
  if (primary.data.length === 1) {
    return primary.data[0]
  }

  const legacy = await collection.limit(2).get()
  if (legacy.data.length > 1) {
    throw createCodedError('BUSINESS_CONFIG_DUPLICATE', '营业配置存在重复记录')
  }
  if (legacy.data.length === 1) {
    return legacy.data[0]
  }

  const base = createDefaultBusinessConfig()
  const published = createDefaultOperationConfig()
  const data = { ...base, published, published_version: 0 }
  await collection.doc(BUSINESS_CONFIG_PRIMARY_ID).set({ data })
  return { _id: BUSINESS_CONFIG_PRIMARY_ID, ...data }
}

async function getConfig() {
  const document = await getOrCreateBusinessConfigDocument()
  const published = getPublishedOperationConfig(document)
  const wechatQrConfigured = isWechatQrConfigured()
  const normalizeTemplateIds = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
  const technicianRefs = published.recommended_technicians || []
  let publicTechnicians = []
  if (technicianRefs.length > 0) {
    const ids = technicianRefs.map(item => item.technician_id)
    const techniciansRes = await db.collection('technicians').where({ _id: _.in(ids), status: _.neq('deleted') }).get()
    publicTechnicians = technicianRefs.map(ref => {
      const technician = (techniciansRes.data || []).find(item => item._id === ref.technician_id)
      return technician ? {
        technician_id: ref.technician_id,
        name: cleanConfigText(technician.name, '', 32),
        specialty: cleanConfigText(technician.specialty || technician.description, '擅长企业服务', 80),
        enabled: ref.enabled !== false,
        sort: ref.sort
      } : null
    }).filter(Boolean)
  }
  return buildSuccessResult({
    ...getLegacyBusinessFields(document),
    ...published,
    admin_login_capabilities: {
      scan_login_enabled: wechatQrConfigured,
      wechat_bind_enabled: wechatQrConfigured
    },
    subscribe_templates: {
      booking: normalizeTemplateIds([
        process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_CREATED,
        process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_CANCELLED,
        process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_REMINDER
      ]).slice(0, 3),
      follow_up: normalizeTemplateIds([
        process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_VERIFIED
      ]).slice(0, 3)
    },
    recommended_technicians: publicTechnicians
  })
}

async function getConfigDraft(adminAuth = {}) {
  const document = await getOrCreateBusinessConfigDocument()
  const published = getPublishedOperationConfig(document)
  const draft = normalizeOperationConfig(document.draft || published, false).value
  return buildSuccessResult({
    draft, published,
    draft_updated_at: Number(document.draft_updated_at || 0),
    draft_updated_by: document.draft_updated_by || null,
    published_at: Number(document.published_at || 0),
    published_version: Number(document.published_version || 0)
  })
}

async function saveConfigDraft(adminAuth = {}, data = {}) {
  const normalized = normalizeOperationConfig(data && data.config, true)
  if (!normalized.ok) return buildErrorResult(normalized.error, 'SESSION_CORRUPTED')
  const document = await getOrCreateBusinessConfigDocument()
  const now = Date.now()
  const editor = { id: adminAuth.admin_user_id || adminAuth.admin_id || '', username: adminAuth.username || '' }
  await db.collection('business_config').doc(document._id).update({ data: {
    draft: normalized.value, draft_updated_at: now, draft_updated_by: editor
  } })
  await writeAdminAuditLog(adminAuth, 'admin.config.draft.save', {
    targetType: 'business_config', targetId: document._id, status: 'success', message: '保存运营配置草稿'
  })
  return buildSuccessResult({ message: '草稿已保存', draft: normalized.value, draft_updated_at: now })
}

async function trimConfigVersions() {
  const old = await db.collection('business_config_versions').orderBy('created_at', 'desc').skip(CONFIG_VERSION_KEEP_LIMIT).limit(100).get()
  await Promise.all((old.data || []).map(item => db.collection('business_config_versions').doc(item._id).remove().catch(() => null)))
}

async function createConfigVersion(adminAuth, config, action, sourceVersion = 0, expectedState = {}) {
  const document = await getOrCreateBusinessConfigDocument()
  const now = Date.now()
  const createdBy = { id: adminAuth.admin_user_id || adminAuth.admin_id || '', username: adminAuth.username || '' }
  let committed = null
  await db.runTransaction(async transaction => {
    const configRef = transaction.collection('business_config').doc(document._id)
    const currentRes = await configRef.get()
    const current = currentRes.data || {}
    const currentVersion = Number(current.published_version || 0)
    if (Object.prototype.hasOwnProperty.call(expectedState, 'publishedVersion') &&
        currentVersion !== Number(expectedState.publishedVersion || 0)) {
      throw createCodedError(CONFIG_CONFLICT_CODE, '营业配置版本已变化')
    }
    if (Object.prototype.hasOwnProperty.call(expectedState, 'draftUpdatedAt') &&
        Number(current.draft_updated_at || 0) !== Number(expectedState.draftUpdatedAt || 0)) {
      throw createCodedError(CONFIG_CONFLICT_CODE, '营业配置草稿已变化')
    }

    const version = currentVersion + 1
    const versionId = createDeterministicDocumentId('config_version', [document._id, version])
    await transaction.collection('business_config_versions').doc(versionId).set({ data: {
      version, action, config, source_version: Number(sourceVersion || 0), created_at: now, created_by: createdBy
    } })
    await configRef.update({ data: {
      published: config, published_version: version, published_at: now, published_by: createdBy,
      draft: config, draft_updated_at: now, draft_updated_by: createdBy,
      ...(expectedState.extraUpdates || {})
    } })
    committed = { version_id: versionId, version, published_at: now }
  })
  trimConfigVersions().catch(err => logSafeError('清理配置版本失败', err))
  return committed
}

async function publishConfig(adminAuth = {}) {
  const document = await getOrCreateBusinessConfigDocument()
  const draft = normalizeOperationConfig(document.draft || getPublishedOperationConfig(document), false).value
  let versionInfo
  try {
    versionInfo = await createConfigVersion(adminAuth, draft, 'publish', 0, {
      publishedVersion: Number(document.published_version || 0),
      draftUpdatedAt: Number(document.draft_updated_at || 0)
    })
  } catch (err) {
    if (err && err.code === CONFIG_CONFLICT_CODE) {
      return buildErrorResult('配置已被其他管理员更新，请刷新后重试', CONFIG_CONFLICT_CODE)
    }
    throw err
  }
  await writeAdminAuditLog(adminAuth, 'admin.config.publish', {
    targetType: 'business_config', targetId: document._id, status: 'success', changes: { version: versionInfo.version }, message: '发布运营配置'
  })
  return buildSuccessResult({ message: '配置已发布', published: draft, ...versionInfo })
}

async function getConfigVersions(adminAuth = {}, data = {}) {
  const page = normalizePagination(data.page, 1, 1000)
  const pageSize = normalizePagination(data.page_size, CONFIG_VERSION_PAGE_SIZE, CONFIG_VERSION_PAGE_SIZE_MAX)
  const [listRes, countRes] = await Promise.all([
    db.collection('business_config_versions').orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
    db.collection('business_config_versions').count()
  ])
  const list = (listRes.data || []).map(({ _id, version, action, created_at, created_by, source_version }) => ({
    id: _id, version, action, created_at, created_by, source_version: Number(source_version || 0)
  }))
  return buildSuccessResult({ list, total: countRes.total || 0, page, page_size: pageSize })
}

async function rollbackConfig(adminAuth = {}, data = {}) {
  if (adminAuth.role !== 'super_admin') return buildErrorResult('仅超级管理员可以回滚配置', 'INSUFFICIENT_PERMISSION')
  const versionId = String(data.version_id || '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(versionId)) return buildErrorResult('配置版本ID不合法', 'SESSION_CORRUPTED')
  let target
  try { target = (await db.collection('business_config_versions').doc(versionId).get()).data } catch (err) { target = null }
  if (!target || !target.config) return buildErrorResult('配置版本不存在', 'SESSION_CORRUPTED')
  const published = normalizeOperationConfig(target.config, false).value
  const document = await getOrCreateBusinessConfigDocument()
  let versionInfo
  try {
    versionInfo = await createConfigVersion(adminAuth, published, 'rollback', target.version, {
      publishedVersion: Number(document.published_version || 0)
    })
  } catch (err) {
    if (err && err.code === CONFIG_CONFLICT_CODE) {
      return buildErrorResult('配置已被其他管理员更新，请刷新后重试', CONFIG_CONFLICT_CODE)
    }
    throw err
  }
  await writeAdminAuditLog(adminAuth, 'admin.config.rollback', {
    targetType: 'business_config', targetId: versionId, status: 'success', changes: { source_version: target.version, version: versionInfo.version }, message: '回滚并发布运营配置'
  })
  return buildSuccessResult({ message: '已回滚并发布', published, source_version: target.version, ...versionInfo })
}

async function initializeProductionContent(adminAuth = {}) {
  if (adminAuth.role !== 'super_admin') {
    return buildErrorResult('仅超级管理员可以初始化生产内容', 'INSUFFICIENT_PERMISSION')
  }

  const document = await getOrCreateBusinessConfigDocument()
  if (Number(document.production_seed_version || 0) >= PRODUCTION_SEED_VERSION) {
    return buildSuccessResult({
      message: '安全生产内容已经初始化，无需重复操作',
      already_initialized: true,
      version: PRODUCTION_SEED_VERSION
    })
  }

  const seed = buildProductionSeed()
  const [serviceCount, articleCount, seededServicesRes, seededArticlesRes] = await Promise.all([
    db.collection('services').where({ status: _.neq('deleted') }).count(),
    db.collection('articles').where({ status: _.neq('deleted') }).count(),
    db.collection('services').where({ seed_version: PRODUCTION_SEED_VERSION }).get(),
    db.collection('articles').where({ seed_version: PRODUCTION_SEED_VERSION }).get()
  ])
  const existingServices = new Map((seededServicesRes.data || [])
    .filter(item => item.status !== 'deleted')
    .map(item => [item.name, item._id]))
  const existingArticles = new Map((seededArticlesRes.data || [])
    .filter(item => item.status !== 'deleted')
    .map(item => [item.title, item._id]))
  const seedServiceIds = []
  let createdServices = 0
  let createdArticles = 0

  if ((serviceCount.total || 0) === 0 || existingServices.size > 0) {
    for (const [index, item] of seed.services.entries()) {
      let serviceId = existingServices.get(item.name)
      if (!serviceId) {
        serviceId = createDeterministicDocumentId('seed_service', [PRODUCTION_SEED_VERSION, index, item.name])
        await db.collection('services').doc(serviceId).set({ data: {
          ...item, created_at: db.serverDate(), updated_at: db.serverDate(), seed_version: PRODUCTION_SEED_VERSION
        } })
        createdServices += 1
      }
      seedServiceIds.push(serviceId)
    }
  }

  if ((articleCount.total || 0) === 0 || existingArticles.size > 0) {
    for (const [index, item] of seed.articles.entries()) {
      if (!existingArticles.has(item.title)) {
        const articleId = createDeterministicDocumentId('seed_article', [PRODUCTION_SEED_VERSION, index, item.title])
        await db.collection('articles').doc(articleId).set({ data: {
          ...item, cover_image: '', created_at: db.serverDate(), updated_at: db.serverDate(), seed_version: PRODUCTION_SEED_VERSION
        } })
        createdArticles += 1
      }
    }
  }

  let recommendationIds = seedServiceIds
  if (recommendationIds.length === 0) {
    const activeServices = await db.collection('services').where({ status: 'active' }).orderBy('sort_order', 'asc').limit(4).get()
    recommendationIds = (activeServices.data || []).map(item => item._id)
  }

  const currentPublished = getPublishedOperationConfig(document)
  const hasAnnouncement = Boolean(currentPublished.announcement && String(currentPublished.announcement.content || '').trim())
  const mergedConfig = normalizeOperationConfig({
    ...currentPublished,
    announcement: hasAnnouncement ? currentPublished.announcement : seed.announcement,
    facilities: Array.isArray(currentPublished.facilities) && currentPublished.facilities.length > 0
      ? currentPublished.facilities
      : seed.facilities,
    recommended_services: Array.isArray(currentPublished.recommended_services) && currentPublished.recommended_services.length > 0
      ? currentPublished.recommended_services
      : recommendationIds.map((serviceId, index) => ({ service_id: serviceId, enabled: true, sort: index + 1 }))
  }, false).value

  let versionInfo
  try {
    versionInfo = await createConfigVersion(adminAuth, mergedConfig, 'publish', 0, {
      publishedVersion: Number(document.published_version || 0),
      draftUpdatedAt: Number(document.draft_updated_at || 0),
      extraUpdates: {
        production_seed_version: PRODUCTION_SEED_VERSION,
        production_seed_initialized_at: Date.now(),
        production_seed_initialized_by: {
          id: adminAuth.admin_user_id || adminAuth.admin_id || '',
          username: adminAuth.username || ''
        }
      }
    })
  } catch (err) {
    if (err && err.code === CONFIG_CONFLICT_CODE) {
      return buildErrorResult('配置已被其他管理员更新，请刷新后重试', CONFIG_CONFLICT_CODE)
    }
    throw err
  }
  await writeAdminAuditLog(adminAuth, 'admin.content.initialize', {
    targetType: 'business_config',
    targetId: document._id,
    status: 'success',
    changes: {
      seed_version: PRODUCTION_SEED_VERSION,
      services_created: createdServices,
      articles_created: createdArticles,
      config_version: versionInfo.version
    },
    message: '初始化安全生产内容'
  })

  return buildSuccessResult({
    message: '安全生产内容已初始化并发布',
    already_initialized: false,
    seed_version: PRODUCTION_SEED_VERSION,
    services_created: createdServices,
    articles_created: createdArticles,
    config_version: versionInfo.version,
    published_at: versionInfo.published_at
  })
}

async function verifyAdminPassword(data) {
  if (!data || !data.password || !data.username) {
    return buildErrorResult('请输入账号和密码', 'SESSION_CORRUPTED')
  }

  const username = (data.username || '').trim()
  if (!username || username.length > 64) {
    verifyPasswordHash(data.password, ADMIN_DUMMY_PASSWORD_HASH)
    return buildErrorResult('账号或密码错误', 'SESSION_CORRUPTED')
  }
  const accountRes = await db.collection('admin_users').where({ username }).limit(1).get()
  if (accountRes.data.length === 0) {
    verifyPasswordHash(data.password, ADMIN_DUMMY_PASSWORD_HASH)
    return buildErrorResult('账号或密码错误', 'SESSION_CORRUPTED')
  }

  const account = accountRes.data[0]
  if (account.status && account.status !== 'active') {
    await writeAdminAuditLog({
      admin_user_id: account._id,
      username: account.username,
      role: account.role,
      tenant_scope: DEFAULT_TENANT_SCOPE
    }, 'admin.login.password', {
      targetType: 'admin_user',
      targetId: account._id,
      status: 'failed',
      message: '停用账号尝试登录'
    })
    return buildErrorResult('账号或密码错误', 'SESSION_CORRUPTED')
  }

  const loginAttempt = await reserveAdminLoginAttempt(account._id)
  if (!loginAttempt.allowed) {
    await writeAdminAuditLog({
      admin_user_id: account._id,
      username: account.username,
      role: account.role,
      tenant_scope: DEFAULT_TENANT_SCOPE
    }, 'admin.login.password', {
      targetType: 'admin_user',
      targetId: account._id,
      status: 'failed',
      message: '登录尝试超过限制'
    })
    return buildErrorResult('账号或密码错误，请稍后再试', 'RATE_LIMITED')
  }

  const passwordCheck = verifyPasswordHash(data.password, account.password_hash)
  if (!passwordCheck.valid) {
    await writeAdminAuditLog({
      admin_user_id: account._id,
      username: account.username,
      role: account.role,
      tenant_scope: DEFAULT_TENANT_SCOPE
    }, 'admin.login.password', {
      targetType: 'admin_user',
      targetId: account._id,
      status: 'failed',
      message: loginAttempt.lockedUntil ? '密码连续错误，账号已临时锁定' : '账号密码登录失败',
      changes: {
        failed_attempts: loginAttempt.failedAttempts,
        locked_until: loginAttempt.lockedUntil || 0
      }
    })
    return buildErrorResult('账号或密码错误', 'SESSION_CORRUPTED')
  }

  const role = normalizeAdminRole(account.role, '')
  if (!role) {
    return buildErrorResult('该管理员角色配置异常，请联系系统管理员', 'ROLE_MISMATCH')
  }

  await clearAdminLoginFailures(account._id)

  if (passwordCheck.legacy) {
    await db.collection('admin_users').doc(account._id).update({
      data: {
        password_hash: hashAdminPassword(data.password),
        password_migrated_at: db.serverDate(),
        updated_at: db.serverDate()
      }
    })
  }

  const token = await createAdminSession({
    admin_user_id: account._id,
    username: account.username,
    role,
    login_method: 'password',
    openid: account.openid || ''
  })

  const sessionExpireAt = Date.now() + ADMIN_SESSION_TTL_MS
  await writeAdminAuditLog({
    admin_user_id: account._id,
    username: account.username,
    role: account.role,
    tenant_scope: DEFAULT_TENANT_SCOPE
  }, 'admin.login.password', {
    targetType: 'admin_user',
    targetId: account._id,
    status: 'success',
    message: '账号密码登录成功'
  })

  return buildSuccessResult({
    token,
    username: account.username,
    role,
    permissions: getRolePermissions(role),
    tenant_scope: DEFAULT_TENANT_SCOPE,
    session_expire_at: sessionExpireAt,
    last_login_at: Date.now(),
    admin_id: account._id,
    admin_user_id: account._id
  })
}

async function reserveAdminLoginAttempt(accountId, now = Date.now()) {
  return db.runTransaction(async transaction => {
    const accountRef = transaction.collection('admin_users').doc(accountId)
    const accountRes = await accountRef.get()
    const currentAccount = accountRes.data || {}
    const activeLock = getActiveLoginLock(currentAccount, now)
    if (activeLock) {
      return { allowed: false, lockedUntil: activeLock }
    }

    const failureState = nextLoginFailureState(currentAccount, now)

    await accountRef.update({
      data: {
        failed_login_attempts: failureState.failedAttempts,
        login_failure_window_started_at: failureState.windowStartedAt,
        login_locked_until: failureState.lockedUntil,
        last_failed_login_at: now,
        updated_at: db.serverDate()
      }
    })
    return { allowed: !failureState.lockedUntil, ...failureState }
  })
}

async function clearAdminLoginFailures(accountId) {
  return db.runTransaction(async transaction => {
    const accountRef = transaction.collection('admin_users').doc(accountId)
    await accountRef.update({
      data: {
        failed_login_attempts: 0,
        login_failure_window_started_at: _.remove(),
        login_locked_until: _.remove(),
        last_failed_login_at: _.remove(),
        last_login_at: db.serverDate(),
        updated_at: db.serverDate()
      }
    })
    return true
  })
}

async function updateConfig(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('配置参数不能为空', 'SESSION_CORRUPTED')
  }

  if (!data.store || typeof data.store !== 'object') {
    return buildErrorResult('门店配置不合法', 'SESSION_CORRUPTED')
  }

  const scheduleInput = data.schedule
  if (!scheduleInput || typeof scheduleInput !== 'object') {
    return buildErrorResult('营业时间配置不合法', 'SESSION_CORRUPTED')
  }

  const validatedSchedule = {}
  for (let day = 1; day <= 7; day += 1) {
    const rawPeriods = scheduleInput[day] || scheduleInput[String(day)] || []
    if (!Array.isArray(rawPeriods)) {
      return buildErrorResult(`星期${day}营业时间配置不合法`, 'SESSION_CORRUPTED')
    }
    if (rawPeriods.length > 3) {
      return buildErrorResult(`星期${day}最多支持3个营业时段`, 'SESSION_CORRUPTED')
    }

    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/
    const cleanedPeriods = []
    for (const item of rawPeriods) {
      const start = String(item && item.start || '').trim()
      const end = String(item && item.end || '').trim()
      if (!start || !end) {
        return buildErrorResult(`星期${day}时段配置不能为空`, 'SESSION_CORRUPTED')
      }
      if (!timeRegex.test(start) || !timeRegex.test(end)) {
        return buildErrorResult(`星期${day}时段时间格式不合法`, 'SESSION_CORRUPTED')
      }
      if (start >= end) {
        return buildErrorResult(`星期${day}存在起止时间异常的时段`, 'SESSION_CORRUPTED')
      }
      cleanedPeriods.push({ start, end })
    }

    const sortedPeriods = [...cleanedPeriods].sort((a, b) => a.start.localeCompare(b.start))
    for (let i = 1; i < sortedPeriods.length; i += 1) {
      if (sortedPeriods[i].start < sortedPeriods[i - 1].end) {
        return buildErrorResult(`星期${day}营业时段存在重叠`, 'SESSION_CORRUPTED')
      }
    }
    validatedSchedule[day] = sortedPeriods
  }

  const sanitized = {
    store: data.store || {},
    schedule: validatedSchedule,
    slot_interval: Number(data.slot_interval || 30),
    holidays: Array.isArray(data.holidays) ? data.holidays : [],
    max_advance_days: parseIntLike(data.max_advance_days, 14),
    branding: normalizeBranding(data.branding),
    home_cards: normalizeHomeCards(data.home_cards),
    facilities: normalizeFacilities(data.facilities),
    recommended_technicians: normalizeRecommendedTechnicians(data.recommended_technicians)
  }

  const storeName = String(sanitized.store.name || '').trim()
  const phone = String(sanitized.store.phone || '').trim()
  const address = String(sanitized.store.address || '').trim()
  const latitude = Number(sanitized.store.latitude)
  const longitude = Number(sanitized.store.longitude)
  if (!storeName || storeName.length > 64) {
    return buildErrorResult('请填写有效的店铺名称', 'SESSION_CORRUPTED')
  }
  if (!/^1\d{10}$/.test(phone)) {
    return buildErrorResult('请填写有效的门店联系电话', 'SESSION_CORRUPTED')
  }
  if (!address || address.length > 200) {
    return buildErrorResult('请填写有效的门店地址', 'SESSION_CORRUPTED')
  }
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || latitude === 0 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || longitude === 0
  ) {
    return buildErrorResult('请填写有效的门店坐标', 'SESSION_CORRUPTED')
  }
  sanitized.store = { name: storeName, phone, address, latitude, longitude }

  if (sanitized.slot_interval < 15 || sanitized.slot_interval > 240) {
    return buildErrorResult('时间粒度范围不合法', 'SESSION_CORRUPTED')
  }

  if (sanitized.max_advance_days < 1 || sanitized.max_advance_days > 90) {
    return buildErrorResult('可预约天数范围不合法', 'SESSION_CORRUPTED')
  }

  const res = await db.collection('business_config').limit(1).get()

  if (res.data.length === 0) {
    await db.collection('business_config').add({ data: sanitized })
  } else {
  await db.collection('business_config')
    .doc(res.data[0]._id)
    .update({ data: sanitized })

  await writeAdminAuditLog(adminAuth, 'admin.config.update', {
    targetType: 'business_config',
    targetId: res.data[0]?._id || '',
    status: 'success',
    changes: sanitized,
    message: '更新营业配置'
  })
  }

  return buildSuccessResult({ message: '更新成功' })
}

async function logoutAdmin(adminAuth) {
  if (!adminAuth || !adminAuth.token) {
    return buildErrorResult('身份验证失败，请重新登录', 'TOKEN_EXPIRED')
  }

  const now = Date.now()
  await db.collection('admin_sessions')
    .doc(adminAuth.token)
    .update({
      data: {
        status: 'logged_out',
        last_accessed_at: now,
        updated_at: now
      }
    })
    .catch(() => {})

  await writeAdminAuditLog(adminAuth, 'admin.logout', {
    targetType: 'admin_user',
    targetId: adminAuth.admin_user_id,
    status: 'success',
    message: '管理员退出登录'
  })

  return buildSuccessResult({
    message: '退出登录成功',
    status: 'logged_out',
    session_id: adminAuth.token
  })
}

// ==================== 服务管理 ====================

async function getServices() {
  const res = await db.collection('services')
    .where({ status: _.neq('deleted') })
    .orderBy('sort_order', 'asc')
    .get()

  // 转换 cloud:// 图片链接为 https 临时链接
  const cloudIds = res.data
    .map(s => s.image_url || s.imageUrl)
    .filter(u => u && u.startsWith('cloud://'))

  if (cloudIds.length > 0) {
    try {
      const urlRes = await cloud.getTempFileURL({ fileList: cloudIds })
      const urlMap = {}
      urlRes.fileList.forEach(f => { urlMap[f.fileID] = f.tempFileURL })
      res.data.forEach(s => {
        const key = s.image_url || s.imageUrl
        if (key && urlMap[key]) {
          s.image_url = urlMap[key]
        }
      })
    } catch (e) {
      logSafeError('转换图片链接失败', e)
    }
  }

  return buildSuccessResult(res.data)
}

async function createService(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const name = String(data.name || '').trim()
  if (!name) {
    return buildErrorResult('服务名称不能为空', 'SESSION_CORRUPTED')
  }
  if (name.length > 60) {
    return buildErrorResult('服务名称长度不能超过60个字符', 'SESSION_CORRUPTED')
  }

  const duration = Number(data.duration || 0)
  if (!Number.isInteger(duration) || duration < 15 || duration > 720) {
    return buildErrorResult('服务时长不合法', 'SESSION_CORRUPTED')
  }

  const price = Number(data.price || 0)
  const defaultCommission = Number(data.default_commission || 0)
  const sortOrder = Number(data.sort_order || 0)
  if (!Number.isInteger(price) || price < 0 || !Number.isInteger(defaultCommission) || defaultCommission < 0) {
    return buildErrorResult('金额应为非负整数', 'SESSION_CORRUPTED')
  }
  if (defaultCommission > price) {
    return buildErrorResult('默认提成不能大于服务价格', 'SESSION_CORRUPTED')
  }

  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
    return buildErrorResult('排序值不合法', 'SESSION_CORRUPTED')
  }

  const status = data.status || 'active'
  if (!['active', 'inactive'].includes(status)) {
    return buildErrorResult('服务状态不合法', 'SESSION_CORRUPTED')
  }

  const imageUrl = String(data.image_url || data.imageUrl || '').trim()
  const description = String(data.description || '').trim()
  if (description.length > 500) {
    return buildErrorResult('服务描述不能超过500个字符', 'SESSION_CORRUPTED')
  }

  const res = await db.collection('services').add({
    data: {
      name,
      duration: parseIntLike(duration),
      price: parseIntLike(price, 0),
      default_commission: parseIntLike(defaultCommission, 0),
      sort_order: parseIntLike(sortOrder, 0),
      status,
      image_url: imageUrl,
      description,
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    }
  })

  await writeAdminAuditLog(adminAuth, 'admin.service.create', {
    targetType: 'service',
    targetId: res._id || '',
    status: 'success',
    changes: {
      name,
      duration: parseIntLike(duration),
      price: parseIntLike(price, 0)
    },
    message: '新增服务'
  })

  return buildSuccessResult({ _id: res._id })
}

async function updateService(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const { id, ...updateData } = data
  if (!id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  const patch = {}
  const target = await db.collection('services').doc(id).get()
  if (!target.data) {
    return buildErrorResult('目标服务不存在', 'SESSION_CORRUPTED')
  }

  const existingPrice = Number(target.data.price || 0)
  if (!Number.isInteger(existingPrice) || existingPrice < 0) {
    return buildErrorResult('目标服务价格异常', 'SESSION_CORRUPTED')
  }

  let effectivePrice = existingPrice

  // 统一图片字段为 image_url
  if (updateData.imageUrl !== undefined) {
    updateData.image_url = updateData.imageUrl
    delete updateData.imageUrl
  }
  if (updateData.name !== undefined) {
    const name = String(updateData.name || '').trim()
    if (!name) {
      return buildErrorResult('服务名称不能为空', 'SESSION_CORRUPTED')
    }
    if (name.length > 60) {
      return buildErrorResult('服务名称长度不能超过60个字符', 'SESSION_CORRUPTED')
    }
    patch.name = name
  }
  if (updateData.duration !== undefined) {
    const duration = Number(updateData.duration)
    if (!Number.isInteger(duration) || duration < 15 || duration > 720) {
      return buildErrorResult('服务时长不合法', 'SESSION_CORRUPTED')
    }
    patch.duration = parseIntLike(duration, 0)
  }
  if (updateData.price !== undefined) {
    const price = Number(updateData.price)
    if (!Number.isInteger(price) || price < 0) {
      return buildErrorResult('服务价格不能小于0', 'SESSION_CORRUPTED')
    }
    effectivePrice = parseIntLike(price, 0)
    patch.price = effectivePrice
  }
  if (updateData.default_commission !== undefined) {
    const defaultCommission = Number(updateData.default_commission)
    if (!Number.isInteger(defaultCommission) || defaultCommission < 0) {
      return buildErrorResult('默认提成不能小于0', 'SESSION_CORRUPTED')
    }

    if (defaultCommission > effectivePrice) {
      return buildErrorResult('默认提成不能大于服务价格', 'SESSION_CORRUPTED')
    }
    patch.default_commission = parseIntLike(defaultCommission, 0)
  }
  if (updateData.status !== undefined && !['active', 'inactive'].includes(updateData.status)) {
    return buildErrorResult('服务状态不合法', 'SESSION_CORRUPTED')
  }
  if (updateData.status !== undefined) {
    patch.status = updateData.status
  }

  if (updateData.sort_order !== undefined) {
    const sortOrder = Number(updateData.sort_order)
    if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
      return buildErrorResult('排序值不合法', 'SESSION_CORRUPTED')
    }
    patch.sort_order = parseIntLike(sortOrder, 0)
  }

  if (updateData.image_url !== undefined) {
    patch.image_url = String(updateData.image_url).trim()
  }

  if (updateData.description !== undefined) {
    const description = String(updateData.description || '').trim()
    if (description.length > 500) {
      return buildErrorResult('服务描述不能超过500个字符', 'SESSION_CORRUPTED')
    }
    patch.description = description
  }

  if (Object.keys(patch).length === 0) {
    return buildSuccessResult({ message: '未修改任何字段' })
  }

  await db.collection('services')
    .doc(id)
    .update({
      data: {
        ...patch,
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.service.update', {
    targetType: 'service',
    targetId: id,
    status: 'success',
    changes: patch,
    message: '更新服务'
  })

  return buildSuccessResult({ message: '更新成功' })
}

async function deleteService(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  const target = await db.collection('services').doc(data.id).get()
  if (!target.data || target.data.status === 'deleted') {
    return buildErrorResult('服务不存在或已删除', 'SESSION_CORRUPTED')
  }

  await db.collection('services').doc(data.id).update({
    data: {
      status: 'deleted',
      deleted_at: db.serverDate(),
      deleted_by: adminAuth.admin_user_id || '',
      updated_at: db.serverDate()
    }
  })

  await writeAdminAuditLog(adminAuth, 'admin.service.delete', {
    targetType: 'service',
    targetId: data.id,
    status: 'success',
    changes: { status: 'deleted' },
    message: '删除服务'
  })

  return buildSuccessResult({ message: '删除成功' })
}

// ==================== 顾问管理 ====================

async function getTechnicians() {
  const res = await db.collection('technicians')
    .where({ status: _.neq('deleted') })
    .orderBy('created_at', 'desc')
    .get()

  return buildSuccessResult(res.data)
}

async function createTechnician(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const name = String(data.name || '').trim()
  const phone = normalizeMobile(data.phone)
  const openid = String(data.openid || '').trim()
  if (!name) {
    return buildErrorResult('顾问姓名不能为空', 'SESSION_CORRUPTED')
  }
  if (name.length > 32) {
    return buildErrorResult('顾问姓名长度不能超过32个字符', 'SESSION_CORRUPTED')
  }
  if (!/^1\d{10}$/.test(phone)) {
    return buildErrorResult('手机号格式不正确', 'SESSION_CORRUPTED')
  }

  // 检查手机号是否已存在
  const existing = await db.collection('technicians')
    .where({ phone, status: _.neq('deleted') })
    .get()

  if (existing.data.length > 0) {
    return buildErrorResult('该手机号已被注册', 'SESSION_CORRUPTED')
  }

  if (openid) {
    const existingOpenid = await db.collection('technicians')
      .where({ openid, status: _.neq('deleted') })
      .get()
    if (existingOpenid.data.length > 0) {
      return buildErrorResult('该微信已绑定其他顾问', 'SESSION_CORRUPTED')
    }
  }

  const res = await db.collection('technicians').add({
    data: {
      name,
      phone,
      openid: openid || '',
      custom_commissions: {},
      status: 'active',
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    }
  })

  await writeAdminAuditLog(adminAuth, 'admin.technician.create', {
    targetType: 'technician',
    targetId: res._id || '',
    status: 'success',
    changes: { name, phone },
    message: '新增顾问'
  })

  return buildSuccessResult({ _id: res._id })
}

async function updateTechnician(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const { id, ...updateData } = data
  if (!id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  const patch = {}
  if (updateData.name !== undefined) {
    const name = String(updateData.name || '').trim()
    if (!name) {
      return buildErrorResult('顾问姓名不能为空', 'SESSION_CORRUPTED')
    }
    if (name.length > 32) {
      return buildErrorResult('顾问姓名长度不能超过32个字符', 'SESSION_CORRUPTED')
    }
    patch.name = name
  }
  if (updateData.phone !== undefined) {
    const phone = normalizeMobile(updateData.phone)
    if (!/^1\d{10}$/.test(phone)) {
      return buildErrorResult('手机号格式不正确', 'SESSION_CORRUPTED')
    }
    const existing = await db.collection('technicians')
      .where({ phone, _id: _.neq(id), status: _.neq('deleted') })
      .get()

    if (existing.data.length > 0) {
      return buildErrorResult('该手机号已被注册', 'SESSION_CORRUPTED')
    }
    patch.phone = phone
  }
  if (updateData.status !== undefined && !['active', 'inactive'].includes(updateData.status)) {
    return buildErrorResult('状态不合法', 'SESSION_CORRUPTED')
  }
  if (updateData.status !== undefined) {
    patch.status = updateData.status
  }

  if (updateData.custom_commissions !== undefined) {
    if (updateData.custom_commissions && typeof updateData.custom_commissions !== 'object') {
      return buildErrorResult('提成设置不合法', 'SESSION_CORRUPTED')
    }
    const cleanedCommissions = {}
    Object.keys(updateData.custom_commissions || {}).forEach((serviceId) => {
      const value = Number(updateData.custom_commissions[serviceId])
      if (!Number.isFinite(value) || value < 0) {
        return
      }
      cleanedCommissions[serviceId] = Math.min(999900, parseIntLike(value, 0))
    })
    patch.custom_commissions = cleanedCommissions
  }

  if (updateData.openid !== undefined) {
    const openid = String(updateData.openid).trim()
    if (openid) {
      const bound = await db.collection('technicians')
        .where({ openid, _id: _.neq(id), status: _.neq('deleted') })
        .get()

      if (bound.data.length > 0) {
        return buildErrorResult('该微信已绑定其他顾问', 'SESSION_CORRUPTED')
      }
    }
    patch.openid = openid
  }

  if (Object.keys(patch).length === 0) {
    return buildSuccessResult({ message: '未修改任何字段' })
  }

  await db.collection('technicians')
    .doc(id)
    .update({
      data: {
        ...patch,
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.technician.update', {
    targetType: 'technician',
    targetId: id,
    status: 'success',
    changes: updateData,
    message: '更新顾问'
  })

  return buildSuccessResult({ message: '更新成功' })
}

async function deleteTechnician(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  const target = await db.collection('technicians').doc(data.id).get()
  if (!target.data || target.data.status === 'deleted') {
    return buildErrorResult('顾问不存在或已删除', 'SESSION_CORRUPTED')
  }

  await db.collection('technicians')
    .doc(data.id)
    .update({
      data: {
        status: 'deleted',
        deleted_at: db.serverDate(),
        deleted_by: adminAuth.admin_user_id || '',
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.technician.delete', {
    targetType: 'technician',
    targetId: data.id,
    status: 'success',
    changes: { status: 'deleted' },
    message: '删除顾问'
  })

  return buildSuccessResult({ message: '删除成功' })
}

// ==================== 客户管理 ====================

async function getCustomers(adminAuth = {}, params = {}) {
  const page = normalizePagination(params && params.page, 1, 200)
  const pageSize = normalizePagination(params && params.page_size, 20, 200)

  let conditions = null
  if (params && params.keyword) {
    const keyword = String(params.keyword).trim()
    if (keyword.length > 30) {
      return buildErrorResult('搜索关键字过长', 'SESSION_CORRUPTED')
    }
    const safeKeyword = escapeRegExp(keyword)
    conditions = _.or([
      { nick_name: db.RegExp({ regexp: safeKeyword, options: 'i' }) },
      { phone: db.RegExp({ regexp: safeKeyword, options: 'i' }) }
    ])
  }

  let countQuery = db.collection('users').where({ status: _.neq('deleted') })
  let dataQuery = db.collection('users').where({ status: _.neq('deleted') })

  if (conditions) {
    countQuery = countQuery.where(conditions)
    dataQuery = dataQuery.where(conditions)
  }

  const countRes = await countQuery.count()
  const total = countRes.total

  const res = await dataQuery
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  const canViewContact = adminAuth.role === 'super_admin' || adminAuth.role === 'manager'
  const list = (res.data || []).map(item => ({
    _id: item._id,
    avatar_url: item.avatar_url || '',
    nick_name: item.nick_name || '',
    phone: canViewContact ? (item.phone || '') : '',
    created_at: item.created_at || 0,
    is_blacklisted: Boolean(item.is_blacklisted),
    notes: canViewContact ? (item.notes || '') : ''
  }))

  return buildSuccessResult({ list, total })
}

async function updateCustomer(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const { id, ...updateData } = data
  if (!id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  const patch = {}

  if (updateData.nick_name !== undefined) {
    const nickName = String(updateData.nick_name || '').trim()
    if (nickName.length > 32) {
      return buildErrorResult('昵称长度不能超过32个字符', 'SESSION_CORRUPTED')
    }
    patch.nick_name = nickName
  }

  if (updateData.phone !== undefined) {
    const phone = normalizeMobile(updateData.phone)
    if (phone && !/^1\d{10}$/.test(phone)) {
      return buildErrorResult('手机号格式不正确', 'SESSION_CORRUPTED')
    }
    patch.phone = phone
  }

  if (updateData.notes !== undefined) {
    const notes = String(updateData.notes || '').trim()
    if (notes.length > 1000) {
      return buildErrorResult('备注内容过长，请缩短后再试', 'SESSION_CORRUPTED')
    }
    patch.notes = notes
  }

  if (Object.keys(patch).length === 0) {
    return buildErrorResult('未修改可变更字段', 'SESSION_CORRUPTED')
  }

  const target = await db.collection('users').doc(id).get()
  if (!target.data || target.data.status === 'deleted') {
    return buildErrorResult('目标客户不存在或已删除', 'SESSION_CORRUPTED')
  }

  await db.collection('users')
    .doc(id)
    .update({
      data: {
        ...patch,
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.customer.update', {
    targetType: 'user',
    targetId: id,
    status: 'success',
    changes: updateData,
    message: '更新客户信息'
  })

  return buildSuccessResult({ message: '更新成功' })
}

async function deleteCustomer(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  const target = await db.collection('users').doc(data.id).get()
  if (!target.data || target.data.status === 'deleted') {
    return buildErrorResult('客户不存在或已删除', 'SESSION_CORRUPTED')
  }

  const openid = String(target.data.openid || '').trim()
  if (openid) {
    const pendingAppointments = await db.collection('appointments')
      .where({ patient_openid: openid, status: 'pending' })
      .limit(1)
      .get()
    if (pendingAppointments.data.length > 0) {
      return buildErrorResult('客户存在待处理预约，无法删除', 'SESSION_CORRUPTED')
    }

    const openidHash = crypto.createHash('sha256').update(openid).digest('hex')
    const anonymizedId = `deleted_${openidHash.slice(0, 32)}`
    while (true) {
      const appointments = await db.collection('appointments')
        .where({ patient_openid: openid })
        .limit(100)
        .get()
      if (appointments.data.length === 0) break
      await Promise.all(appointments.data.map(appointment => db.collection('appointments').doc(appointment._id).update({
        data: {
          patient_openid: anonymizedId,
          patient_anonymized_at: db.serverDate(),
          updated_at: db.serverDate()
        }
      })))
    }

    while (true) {
      const users = await db.collection('users').where({ openid }).limit(100).get()
      const duplicates = users.data.filter(user => user._id !== data.id)
      if (duplicates.length === 0) break
      await Promise.all(duplicates.map(async user => {
        const avatarFileId = String(user.avatar_url || '')
        if (/^cloud:\/\/[^/]+\/avatars\//.test(avatarFileId)) {
          await cloud.deleteFile({ fileList: [avatarFileId] })
        }
        await db.collection('users').doc(user._id).remove()
      }))
    }

    const tombstoneId = `user_${openidHash}`
    const avatarFileId = String(target.data.avatar_url || '')
    if (/^cloud:\/\/[^/]+\/avatars\//.test(avatarFileId)) {
      await cloud.deleteFile({ fileList: [avatarFileId] })
    }
    const tombstone = {
      status: 'deleted',
      deleted_by_admin: true,
      deleted_at: db.serverDate(),
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    }
    await db.collection('users').doc(tombstoneId).set({ data: tombstone })
    if (data.id !== tombstoneId) {
      await db.collection('users').doc(data.id).remove()
    }
  } else {
    const avatarFileId = String(target.data.avatar_url || '')
    if (/^cloud:\/\/[^/]+\/avatars\//.test(avatarFileId)) {
      await cloud.deleteFile({ fileList: [avatarFileId] })
    }
    await db.collection('users').doc(data.id).remove()
  }

  await writeAdminAuditLog(adminAuth, 'admin.customer.delete', {
    targetType: 'user',
    targetId: data.id,
    status: 'success',
    message: '删除客户'
  })

  return buildSuccessResult({ message: '删除成功' })
}

// ==================== 预约管理 ====================

async function getAdminAppointments(adminAuth = {}, params = {}) {
  const page = normalizePagination(params && params.page, 1, 200)
  const pageSize = normalizePagination(params && params.page_size, 20, 200)
  const normalizedStatus = normalizeAppointmentStatus(params && params.status)

  let conditions = {}
  if (params) {
    if (params.status) {
      if (!normalizedStatus) {
        return buildErrorResult('状态参数不合法', 'SESSION_CORRUPTED')
      }
      conditions.status = normalizedStatus
    }
    if (params.technician_id) {
      conditions.technician_id = String(params.technician_id).trim()
    }
    if (params.patient_openid) {
      conditions.patient_openid = String(params.patient_openid).trim()
    }
    if (params.patient_user_id) {
      const patientUserId = normalizeAdminId(params.patient_user_id)
      if (!patientUserId) {
        return buildErrorResult('客户 id 不合法', 'SESSION_CORRUPTED')
      }
      const patientRes = await db.collection('users').doc(patientUserId).get()
      const patientOpenid = String(patientRes.data && patientRes.data.openid || '').trim()
      if (!patientOpenid) {
        return buildSuccessResult({ list: [], total: 0 })
      }
      conditions.patient_openid = patientOpenid
    }
    if (params.start_date && params.end_date) {
      if (!isDateYMD(params.start_date) || !isDateYMD(params.end_date)) {
        return buildErrorResult('日期范围参数不合法', 'SESSION_CORRUPTED')
      }
      if (!isStartNoLaterThanEnd(params.start_date, params.end_date)) {
        return buildErrorResult('日期范围参数不合法', 'SESSION_CORRUPTED')
      }
      conditions.date = _.gte(params.start_date).and(_.lte(params.end_date))
    } else if (params.start_date) {
      if (!isDateYMD(params.start_date)) {
        return buildErrorResult('日期参数不合法', 'SESSION_CORRUPTED')
      }
      conditions.date = params.start_date
    } else if (params.date) {
      if (!isDateYMD(params.date)) {
        return buildErrorResult('日期参数不合法', 'SESSION_CORRUPTED')
      }
      conditions.date = params.date
    }
  }

  let countQuery = db.collection('appointments')
  let dataQuery = db.collection('appointments')

  if (Object.keys(conditions).length > 0) {
    countQuery = countQuery.where(conditions)
    dataQuery = dataQuery.where(conditions)
  }

  const countRes = await countQuery.count()
  const total = countRes.total

  const res = await dataQuery
    .orderBy('created_at', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()

  // 过滤掉 _init 文档
  const realAppointments = res.data.filter(a => !a._init)

  // 获取关联数据
  const appointments = await Promise.all(realAppointments.map(async (apt) => {
    // 获取服务名称
    let serviceNames = ''
    if (apt.services && apt.services.length > 0) {
      const servicesRes = await db.collection('services')
        .where({ _id: _.in(apt.services) })
        .get()
      serviceNames = servicesRes.data.map(s => s.name).join('、')
    }

    // 获取顾问名称
    let technicianName = ''
    if (apt.technician_id) {
      try {
        const techRes = await db.collection('technicians')
          .doc(apt.technician_id)
          .get()
        if (techRes.data) {
          technicianName = techRes.data.name
        }
      } catch (e) {
        logSafeError('获取顾问信息失败', e)
      }
    }

    // 获取客户信息
    let patientName = '未知用户'
    if (apt.patient_openid) {
      try {
        const userRes = await db.collection('users')
          .where({ openid: apt.patient_openid })
          .get()
        if (userRes.data.length > 0) {
          patientName = userRes.data[0].nick_name || '未知用户'
        }
      } catch (e) {
        logSafeError('获取用户信息失败', e)
      }
    }

    return {
      _id: apt._id,
      date: apt.date || '',
      start_time: apt.start_time || '',
      end_time: apt.end_time || '',
      status: apt.status || '',
      created_at: apt.created_at || 0,
      verified_at: apt.verified_at || 0,
      reminder_failure_count: Math.max(0, Number(apt.reminder_failure_count || 0)),
      reminder_last_failed_at: apt.reminder_last_failed_at || 0,
      reminder_last_error_code: String(apt.reminder_last_error_code || '').slice(0, 64),
      reminder_delivery_uncertain: Boolean(apt.reminder_delivery_uncertain_key ||
        (apt.reminder_claim_key && Number(apt.reminder_lease_until || 0) <= Date.now())),
      reminder_delivery_uncertain_at: apt.reminder_delivery_uncertain_at || apt.reminder_claimed_at || 0,
      service_names: serviceNames,
      technician_name: technicianName,
      patient_name: patientName
    }
  }))

  return buildSuccessResult({ list: appointments, total })
}

// ==================== 休息管理 ====================

async function getHolidays(params) {
  let query = db.collection('holidays')

  if (params && params.type) {
    query = query.where({ type: params.type })
  }

  const res = await query
    .orderBy('date', 'asc')
    .get()

  return buildSuccessResult(res.data)
}

async function addHoliday(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const date = String(data.date || '').trim()
  if (!isDateYMD(date)) {
    return buildErrorResult('节假日日期格式不合法', 'SESSION_CORRUPTED')
  }

  const type = data.type || 'closure'
  if (!['closure', 'special'].includes(type)) {
    return buildErrorResult('节假日类型不合法', 'SESSION_CORRUPTED')
  }

  const reason = normalizeTextField(data.reason, 100)
  if (!reason || reason.length > 100) {
    return buildErrorResult(reason ? '节假日说明不能超过 100 字' : '节假日说明不能为空', 'SESSION_CORRUPTED')
  }

  const dateError = validateDateRangeFilter(date)
  if (dateError) {
    return buildErrorResult(dateError, 'SESSION_CORRUPTED')
  }

  // 检查是否已存在
  const existing = await db.collection('holidays')
    .where({ date, type })
    .get()

  if (existing.data.length > 0) {
    return buildErrorResult('该日期已存在', 'SESSION_CORRUPTED')
  }

  const holidayId = createDeterministicDocumentId('holiday', [DEFAULT_TENANT_SCOPE, date, type])
  await db.collection('holidays').doc(holidayId).set({
    data: { date, type, reason, tenant_scope: DEFAULT_TENANT_SCOPE, created_at: db.serverDate() }
  })

  await writeAdminAuditLog(adminAuth, 'admin.holiday.add', {
    targetType: 'holiday',
    targetId: holidayId,
    status: 'success',
    changes: data,
    message: '新增节假日休息日'
  })

  return buildSuccessResult({ _id: holidayId })
}

async function deleteHoliday(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
  return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }
  await db.collection('holidays').doc(data.id).remove()

  await writeAdminAuditLog(adminAuth, 'admin.holiday.delete', {
    targetType: 'holiday',
    targetId: data.id,
    status: 'success',
    message: '删除节假日休息日'
  })
  return buildSuccessResult({ message: '删除成功' })
}

async function getTechDaysOff() {
  const res = await db.collection('tech_days_off')
    .orderBy('date', 'desc')
    .get()

  // 获取顾问名称
  const daysOff = await Promise.all(res.data.map(async (item) => {
    let technicianName = ''
    if (item.technician_id) {
      try {
        const techRes = await db.collection('technicians')
          .doc(item.technician_id)
          .get()
        if (techRes.data) {
          technicianName = techRes.data.name
        }
      } catch (e) {
        logSafeError('获取顾问信息失败', e)
      }
    }
    return { ...item, technician_name: technicianName }
  }))

  return buildSuccessResult(daysOff)
}

async function addTechDayOff(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const technicianId = normalizeAdminId(data.technician_id)
  const date = String(data.date || '').trim()
  if (!technicianId || !isDateYMD(date)) {
    return buildErrorResult('缺少顾问或日期', 'SESSION_CORRUPTED')
  }

  const technicianRes = await db.collection('technicians')
    .doc(technicianId)
    .get()

  if (!technicianRes.data || technicianRes.data.status === 'deleted') {
    return buildErrorResult('关联顾问不存在', 'SESSION_CORRUPTED')
  }

  const reason = normalizeTextField(data.reason, 80)
  if (reason && reason.length > 80) {
    return buildErrorResult('休息原因不能超过80个字符', 'SESSION_CORRUPTED')
  }

  const dateError = validateDateRangeFilter(date)
  if (dateError) {
    return buildErrorResult(dateError, 'SESSION_CORRUPTED')
  }

  // 检查是否已存在
  const existing = await db.collection('tech_days_off')
    .where({
      technician_id: technicianId,
      date
    })
    .get()

  if (existing.data.length > 0) {
    return buildErrorResult('该顾问当天已有休假记录', 'SESSION_CORRUPTED')
  }

  const dayOffId = createDeterministicDocumentId('tech_day_off', [technicianId, date])
  await db.collection('tech_days_off').doc(dayOffId).set({
    data: {
      technician_id: technicianId,
      technician_name: technicianRes.data.name || '',
      date,
      reason: reason || '',
      created_at: db.serverDate()
    }
  })

  await writeAdminAuditLog(adminAuth, 'admin.tech_dayoff.add', {
    targetType: 'tech_days_off',
    targetId: dayOffId,
    status: 'success',
    changes: data,
    message: '新增顾问休息日'
  })

  return buildSuccessResult({ _id: dayOffId })
}

async function deleteTechDayOff(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }
  await db.collection('tech_days_off').doc(data.id).remove()

  await writeAdminAuditLog(adminAuth, 'admin.tech_dayoff.delete', {
    targetType: 'tech_days_off',
    targetId: data.id,
    status: 'success',
    message: '删除顾问休息日'
  })
  return buildSuccessResult({ message: '删除成功' })
}

// ==================== 提成统计 ====================

async function getCommissions(params) {
  const page = normalizePagination(params && params.page, 1, 200)
  const pageSize = normalizePagination(params && params.page_size, 20, 200)

  let conditions = {}
  const technicianId = normalizeAdminId(params && params.technician_id)
  const hasDateFilter = Boolean((params && (params.start_date || params.end_date)))
  const dateError = validateDateRangeFilter(params && params.start_date, params && params.end_date, hasDateFilter)
  if (dateError) {
    return buildErrorResult(dateError, 'SESSION_CORRUPTED')
  }

  if (params) {
    if (technicianId) {
      if (technicianId.length > 64) {
        return buildErrorResult('顾问 id 长度不合法', 'SESSION_CORRUPTED')
      }
      conditions.technician_id = technicianId
    }
    if (params.start_date && params.end_date) {
      conditions.date = _.gte(String(params.start_date).trim()).and(_.lte(String(params.end_date).trim()))
    }
  }

  let countQuery = db.collection('commission_records')
  let dataQuery = db.collection('commission_records')

  if (Object.keys(conditions).length > 0) {
    countQuery = countQuery.where(conditions)
    dataQuery = dataQuery.where(conditions)
  }

  const countRes = await countQuery.count()
  const total = countRes.total

  const res = await dataQuery
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  return buildSuccessResult({ list: res.data, total })
}

async function getCommissionSummary(params) {
  let conditions = {}
  const technicianId = normalizeAdminId(params && params.technician_id)
  const hasDateFilter = Boolean((params && (params.start_date || params.end_date)))
  const dateError = validateDateRangeFilter(params && params.start_date, params && params.end_date, hasDateFilter)
  if (dateError) {
    return buildErrorResult(dateError, 'SESSION_CORRUPTED')
  }

  if (params) {
    if (technicianId) {
      if (technicianId.length > 64) {
        return buildErrorResult('顾问 id 长度不合法', 'SESSION_CORRUPTED')
      }
      conditions.technician_id = technicianId
    }
    if (params.start_date && params.end_date) {
      conditions.date = _.gte(String(params.start_date).trim()).and(_.lte(String(params.end_date).trim()))
    }
  }

  let query = db.collection('commission_records')
  if (Object.keys(conditions).length > 0) {
    query = query.where(conditions)
  }

  let total = 0
  let count = 0
  let skip = 0
  while (true) {
    const page = await query.skip(skip).limit(COMMISSION_SUMMARY_PAGE_SIZE).get()
    const records = page.data || []
    total += records.reduce((sum, item) => sum + Number(item.commission_amount || 0), 0)
    count += records.length
    if (records.length < COMMISSION_SUMMARY_PAGE_SIZE) break
    skip += records.length
  }

  return buildSuccessResult({ total, count })
}

// ==================== 文章管理 ====================

async function getArticles() {
  const res = await db.collection('articles')
    .where({ status: _.neq('deleted') })
    .orderBy('sort_order', 'asc')
    .get()

  return buildSuccessResult(res.data)
}

async function createArticle(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const title = String(data.title || '').trim()
  if (!title) {
    return buildErrorResult('文章标题不能为空', 'SESSION_CORRUPTED')
  }
  if (title.length > 80) {
    return buildErrorResult('文章标题不能超过80个字符', 'SESSION_CORRUPTED')
  }

  const summary = String(data.summary || '').trim()
  if (summary.length > 300) {
    return buildErrorResult('文章摘要不能超过300个字符', 'SESSION_CORRUPTED')
  }

  const status = data.status || 'draft'
  if (!['draft', 'published', 'hidden', 'deleted'].includes(status)) {
    return buildErrorResult('文章状态不合法', 'SESSION_CORRUPTED')
  }

  const content = String(data.content || '').trim()
  if (hasRestrictedPublicContent({ title, summary, content })) {
    return buildErrorResult('文章内容不符合企业资讯发布范围，请修改后再保存', 'CONTENT_POLICY_REJECTED')
  }

  const res = await db.collection('articles').add({
    data: {
      title,
      summary,
      cover_image: String(data.cover_image || '').trim(),
      content,
      sort_order: Number.isFinite(Number(data.sort_order)) ? parseIntLike(data.sort_order, 0) : 0,
      status,
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    }
  })

  await writeAdminAuditLog(adminAuth, 'admin.article.create', {
    targetType: 'article',
    targetId: res._id || '',
    status: 'success',
    changes: {
      title,
      status
    },
    message: '新增文章'
  })

  return buildSuccessResult({ _id: res._id })
}

async function updateArticle(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const { id, ...updateData } = data
  if (!id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  const patch = {}

  if (updateData.title !== undefined) {
    const title = String(updateData.title || '').trim()
    if (!title) {
      return buildErrorResult('文章标题不能为空', 'SESSION_CORRUPTED')
    }
    if (title.length > 80) {
      return buildErrorResult('文章标题不能超过80个字符', 'SESSION_CORRUPTED')
    }
    patch.title = title
  }

  if (updateData.summary !== undefined) {
    const summary = String(updateData.summary || '').trim()
    if (summary.length > 300) {
      return buildErrorResult('文章摘要不能超过300个字符', 'SESSION_CORRUPTED')
    }
    patch.summary = summary
  }

  if (updateData.cover_image !== undefined) {
    patch.cover_image = String(updateData.cover_image || '').trim()
  }

  if (updateData.content !== undefined) {
    patch.content = String(updateData.content || '').trim()
  }

  if (updateData.sort_order !== undefined) {
    const sortOrder = Number(updateData.sort_order)
    if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
      return buildErrorResult('排序值不合法', 'SESSION_CORRUPTED')
    }
    patch.sort_order = parseIntLike(sortOrder, 0)
  }

  if (updateData.status !== undefined && !['draft', 'published', 'hidden'].includes(updateData.status)) {
    return buildErrorResult('文章状态不合法', 'SESSION_CORRUPTED')
  }
  if (updateData.status !== undefined) {
    patch.status = updateData.status
  }

  if (Object.keys(patch).length === 0) {
    return buildSuccessResult({ message: '未修改任何字段' })
  }

  const existingRes = await db.collection('articles').doc(id).get()
  if (!existingRes.data || existingRes.data.status === 'deleted') {
    return buildErrorResult('文章不存在', 'SESSION_CORRUPTED')
  }
  if (hasRestrictedPublicContent({ ...existingRes.data, ...patch })) {
    return buildErrorResult('文章内容不符合企业资讯发布范围，请修改后再保存', 'CONTENT_POLICY_REJECTED')
  }

  await db.collection('articles')
    .doc(id)
    .update({
      data: {
        ...patch,
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.article.update', {
    targetType: 'article',
    targetId: id,
    status: 'success',
    changes: patch,
    message: '更新文章'
  })

  return buildSuccessResult({ message: '更新成功' })
}

async function toggleArticleStatus(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }
  if (!data.status) {
    return buildErrorResult('缺少文章状态', 'SESSION_CORRUPTED')
  }
  if (!['draft', 'published', 'hidden'].includes(data.status)) {
    return buildErrorResult('文章状态不合法', 'SESSION_CORRUPTED')
  }
  if (data.status === 'published') {
    const articleRes = await db.collection('articles').doc(data.id).get()
    if (!articleRes.data || articleRes.data.status === 'deleted') {
      return buildErrorResult('文章不存在', 'SESSION_CORRUPTED')
    }
    if (hasRestrictedPublicContent(articleRes.data)) {
      return buildErrorResult('文章内容不符合企业资讯发布范围，不能发布', 'CONTENT_POLICY_REJECTED')
    }
  }
  await db.collection('articles')
    .doc(data.id)
    .update({
      data: {
        status: data.status,
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.article.status', {
    targetType: 'article',
    targetId: data.id,
    status: 'success',
    changes: { status: data.status },
    message: '切换文章状态'
  })

  return buildSuccessResult({ message: '状态更新成功' })
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return value === 1
  }

  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true'
  }

  return false
}

async function deleteArticle(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  await db.collection('articles').doc(data.id).update({
    data: {
      status: 'deleted',
      updated_at: db.serverDate()
    }
  })

  await writeAdminAuditLog(adminAuth, 'admin.article.delete', {
    targetType: 'article',
    targetId: data.id,
    status: 'success',
    message: '删除文章'
  })

  return buildSuccessResult({ message: '删除成功' })
}

// ==================== 新增功能 ====================

async function getAppointmentDetail(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }
  const res = await db.collection('appointments').doc(data.id).get()
  const apt = res.data
  if (!apt || apt._init) {
    return buildErrorResult('预约记录不存在', 'SESSION_CORRUPTED')
  }

  // 获取服务名称
  let serviceNames = ''
  if (apt.services && apt.services.length > 0) {
    const servicesRes = await db.collection('services')
      .where({ _id: _.in(apt.services) })
      .get()
    serviceNames = servicesRes.data.map(s => s.name).join('、')
  }

  // 获取顾问名称
  let technicianName = ''
  if (apt.technician_id) {
    try {
      const techRes = await db.collection('technicians').doc(apt.technician_id).get()
      if (techRes.data) technicianName = techRes.data.name
    } catch (e) {
      logSafeError('获取顾问信息失败', e)
    }
  }

  // 获取客户信息
  let patientName = '未知用户'
  let patientPhone = ''
  if (apt.patient_openid) {
    try {
      const userRes = await db.collection('users')
        .where({ openid: apt.patient_openid })
        .get()
      if (userRes.data.length > 0) {
        patientName = userRes.data[0].nick_name || '未知用户'
        patientPhone = userRes.data[0].phone || ''
      }
    } catch (e) {
      logSafeError('获取用户信息失败', e)
    }
  }

  return buildSuccessResult({
    _id: apt._id,
    date: apt.date || '',
    start_time: apt.start_time || '',
    end_time: apt.end_time || '',
    status: apt.status || '',
    created_at: apt.created_at || 0,
    verified_at: apt.verified_at || 0,
    reminder_failure_count: Math.max(0, Number(apt.reminder_failure_count || 0)),
    reminder_last_failed_at: apt.reminder_last_failed_at || 0,
    reminder_last_error_code: String(apt.reminder_last_error_code || '').slice(0, 64),
    reminder_delivery_uncertain: Boolean(apt.reminder_delivery_uncertain_key ||
      (apt.reminder_claim_key && Number(apt.reminder_lease_until || 0) <= Date.now())),
    reminder_delivery_uncertain_at: apt.reminder_delivery_uncertain_at || apt.reminder_claimed_at || 0,
    service_names: serviceNames,
    technician_name: technicianName,
    patient_name: patientName,
    patient_phone: adminAuth.role === 'viewer' ? '' : patientPhone
  })
}

async function toggleBlacklist(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }

  if (!['boolean', 'number', 'string'].includes(typeof data.is_blacklisted) ||
    (typeof data.is_blacklisted === 'string' && !['0', '1', 'true', 'false'].includes(data.is_blacklisted))) {
    return buildErrorResult('黑名单状态不合法', 'SESSION_CORRUPTED')
  }

  const isBlacklisted = normalizeBoolean(data.is_blacklisted)
  await db.collection('users')
    .doc(data.id)
    .update({
      data: {
        is_blacklisted: isBlacklisted,
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.customer.blacklist', {
    targetType: 'user',
    targetId: data.id,
    status: 'success',
    changes: { is_blacklisted: isBlacklisted },
    message: isBlacklisted ? '加入黑名单' : '移除黑名单'
  })

  return buildSuccessResult({ message: isBlacklisted ? '已加入黑名单' : '已取消黑名单' })
}

async function toggleTechnicianStatus(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少必要参数: id', 'SESSION_CORRUPTED')
  }
  if (!['active', 'inactive'].includes(data.status)) {
    return buildErrorResult('顾问状态不合法', 'SESSION_CORRUPTED')
  }

  await db.collection('technicians')
    .doc(data.id)
    .update({
      data: {
        status: data.status,
        updated_at: db.serverDate()
      }
    })

  await writeAdminAuditLog(adminAuth, 'admin.technician.status', {
    targetType: 'technician',
    targetId: data.id,
    status: 'success',
    changes: { status: data.status },
    message: '更新顾问状态'
  })

  return buildSuccessResult({ message: '状态更新成功' })
}

// ==================== 导入法定节假日 ====================

async function importHolidays() {
  // 2026年中国法定节假日
  const holidays = [
    { date: '2026-01-01', reason: '元旦' },
    { date: '2026-02-15', reason: '春节' },
    { date: '2026-02-16', reason: '春节' },
    { date: '2026-02-17', reason: '春节' },
    { date: '2026-02-18', reason: '春节' },
    { date: '2026-02-19', reason: '春节' },
    { date: '2026-02-20', reason: '春节' },
    { date: '2026-02-21', reason: '春节' },
    { date: '2026-04-04', reason: '清明节' },
    { date: '2026-04-05', reason: '清明节' },
    { date: '2026-04-06', reason: '清明节' },
    { date: '2026-05-01', reason: '劳动节' },
    { date: '2026-05-02', reason: '劳动节' },
    { date: '2026-05-03', reason: '劳动节' },
    { date: '2026-05-04', reason: '劳动节' },
    { date: '2026-05-05', reason: '劳动节' },
    { date: '2026-06-19', reason: '端午节' },
    { date: '2026-06-20', reason: '端午节' },
    { date: '2026-06-21', reason: '端午节' },
    { date: '2026-10-01', reason: '国庆节' },
    { date: '2026-10-02', reason: '国庆节' },
    { date: '2026-10-03', reason: '国庆节' },
    { date: '2026-10-04', reason: '中秋节' },
    { date: '2026-10-05', reason: '国庆节' },
    { date: '2026-10-06', reason: '国庆节' },
    { date: '2026-10-07', reason: '国庆节' },
  ]

  let added = 0
  let skipped = 0

  for (const h of holidays) {
    const existing = await db.collection('holidays')
      .where({ date: h.date, type: 'closure' })
      .get()

    if (existing.data.length > 0) {
      skipped++
      continue
    }

    const holidayId = createDeterministicDocumentId('holiday', [DEFAULT_TENANT_SCOPE, h.date, 'closure'])
    await db.collection('holidays').doc(holidayId).set({
      data: {
        date: h.date,
        type: 'closure',
        reason: h.reason,
        tenant_scope: DEFAULT_TENANT_SCOPE,
        created_at: db.serverDate()
      }
    })
    added++
  }

  return {
    code: 0,
    data: { message: `导入完成：新增 ${added} 天，跳过 ${skipped} 天已存在记录` }
  }
}

// ==================== 扫码登录 ====================

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex')
}

function normalizeLoginSessionType(type = '') {
  return type === 'admin_bind' ? 'admin_bind' : 'admin_login'
}

async function createLoginSession(data = {}, context = {}) {
  if (!isWechatQrConfigured()) {
    return buildErrorResult('扫码登录暂不可用，请使用账号密码登录', 'SCAN_LOGIN_UNAVAILABLE')
  }

  await cleanupExpiredLoginSessions()

  const reservationId = normalizeMiniProgramScene(createCallerBoundLoginSessionId(context))
  if (!reservationId) {
    return buildErrorResult('登录环境异常，请刷新后重试', 'SESSION_CORRUPTED')
  }

  const sessionId = generateSessionId()
  const now = Date.now()
  const expiresAt = now + LOGIN_SESSION_TTL_MS
  const browserSecret = createBrowserSecret()

  const reservation = await db.runTransaction(async transaction => {
    const reservationRef = transaction.collection('login_sessions').doc(reservationId)
    let existingReservation = {}
    try {
      existingReservation = (await reservationRef.get()).data || {}
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      if (!message.includes(`document with _id ${reservationId} does not exist`)) throw err
    }

    const retryAfterMs = getScanQrRetryAfter(existingReservation, now)
    if (retryAfterMs > 0) return { allowed: false }

    await reservationRef.set({
      data: {
        status: 'rate_limit',
        type: 'admin_login_rate_limit',
        qr_requested_at: now,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
        tenant_scope: DEFAULT_TENANT_SCOPE,
        session_expire_at: expiresAt
      }
    })

    const sessionRef = transaction.collection('login_sessions').doc(sessionId)
    await sessionRef.set({
      data: {
        status: 'pending',
        type: 'admin_login',
        openid: '',
        browser_secret_hash: hashBrowserSecret(browserSecret),
        browser_secret_version: 1,
        qr_source: data.prefer_miniprogram_qr ? 'miniprogram' : 'default',
        qr_requested_at: now,
        created_at: now,
        expires_at: expiresAt,
        tenant_scope: DEFAULT_TENANT_SCOPE,
        session_expire_at: expiresAt
      }
    })
    return { allowed: true }
  })

  if (!reservation.allowed) {
    return buildErrorResult('二维码生成请求过于频繁，请稍后重试', 'RATE_LIMITED')
  }

  const qrCodeBase64 = await createMiniProgramLoginQrCode(sessionId)
  if (!qrCodeBase64) {
    await db.collection('login_sessions').doc(sessionId).update({
      data: {
        status: 'expired',
        reject_reason: '小程序码生成失败'
      }
    })
    return buildErrorResult('小程序码生成失败，请检查微信 AppSecret 或云调用权限配置', 'SESSION_CORRUPTED')
  }

  await writeAdminAuditLog({}, 'admin.scan_qr.create', {
    targetType: 'login_session',
    targetId: sessionId,
    status: 'success',
    message: '管理员扫码登录二维码创建',
    changes: {
      type: 'admin_login',
      source: data.prefer_miniprogram_qr ? 'miniprogram' : 'default'
    }
  })

  return buildSuccessResult(buildScanSessionResponse(sessionId, {
    status: 'pending',
    type: 'admin_login',
    username: '',
    expires_at: expiresAt,
    qr_code_base64: qrCodeBase64,
    qr_code_type: 'miniprogram',
    browser_secret: browserSecret,
    message: '请使用微信扫码完成登录确认'
  }))
}

async function createAdminBindSession(data = {}) {
  if (!isWechatQrConfigured()) {
    return buildErrorResult('微信绑定暂不可用，请手动填写 OpenID', 'SCAN_LOGIN_UNAVAILABLE')
  }

  await cleanupExpiredLoginSessions()

  if (!data || !data.id) {
    return buildErrorResult('缺少管理员账号 id', 'SESSION_CORRUPTED')
  }

  const adminRes = await db.collection('admin_users').doc(data.id).get()
  if (!adminRes.data) {
    return buildErrorResult('管理员账号不存在', 'SESSION_CORRUPTED')
  }

  if (adminRes.data.status && adminRes.data.status !== 'active') {
    return buildErrorResult('管理员账号已停用，不能生成绑定二维码', 'SESSION_CORRUPTED')
  }

  const sessionId = normalizeMiniProgramScene(generateSessionId())
  if (!sessionId) {
    return buildErrorResult('会话创建失败', 'SESSION_CORRUPTED')
  }

  const now = Date.now()
  const expiresAt = now + LOGIN_SESSION_TTL_MS
  const browserSecret = createBrowserSecret()

  await db.collection('login_sessions').add({
    data: {
      _id: sessionId,
      status: 'pending',
      type: 'admin_bind',
      admin_user_id: data.id,
      admin_username: adminRes.data.username || '',
      openid: '',
      browser_secret_hash: hashBrowserSecret(browserSecret),
      browser_secret_version: 1,
      qr_source: 'miniprogram',
      created_at: now,
      expires_at: expiresAt,
      tenant_scope: DEFAULT_TENANT_SCOPE,
      session_expire_at: expiresAt
    }
  })

  await writeAdminAuditLog(
    {
      admin_user_id: adminRes.data._id,
      username: adminRes.data.username,
      role: normalizeAdminRole(adminRes.data.role, ''),
      tenant_scope: DEFAULT_TENANT_SCOPE
    },
    'admin.bind_qr.create',
    {
      targetType: 'login_session',
      targetId: sessionId,
      status: 'success',
      message: '管理员微信绑定二维码创建',
      changes: {
        admin_user_id: data.id,
        admin_username: adminRes.data.username
      }
    }
  )

  const qrCodeBase64 = await createMiniProgramLoginQrCode(sessionId)
  if (!qrCodeBase64) {
    await db.collection('login_sessions').doc(sessionId).update({
      data: {
        status: 'expired',
        reject_reason: '小程序码生成失败'
      }
    })
    return buildErrorResult('小程序码生成失败，请检查微信 AppSecret 或云调用权限配置', 'SESSION_CORRUPTED')
  }

  await writeAdminAuditLog({
    admin_user_id: adminRes.data._id,
    username: adminRes.data.username,
    role: adminRes.data.role,
    tenant_scope: DEFAULT_TENANT_SCOPE
  }, 'admin.bind_qr_create', {
    targetType: 'admin_user',
    targetId: adminRes.data._id,
    status: 'success',
    message: '管理员微信绑定二维码生成'
  })

  return buildSuccessResult(buildScanSessionResponse(sessionId, {
    status: 'pending',
    type: 'admin_bind',
    username: adminRes.data.username || '',
    expires_at: expiresAt,
    qr_code_base64: qrCodeBase64,
    qr_code_type: 'miniprogram',
    browser_secret: browserSecret,
    admin_user_id: data.id,
    message: '请使用微信扫码完成绑定确认'
  }))
}

async function createMiniProgramLoginQrCode(sessionId) {
  const pagePath = getMiniProgramPagePath()
  const scene = normalizeMiniProgramScene(sessionId)

  if (!scene) {
    logSafeError('小程序码场景参数不合法', { code: 'INVALID_SCENE' })
    return ''
  }

  try {
    const accessToken = await getWechatAccessToken()
    const codeUrl = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`
    const result = await requestWechatJson(codeUrl, 'POST', {
      scene,
      page: pagePath,
      check_path: false,
      env_version: WECHAT_MINIPROGRAM_QR_ENV_VERSION,
      width: 280
    })

    if (!result || !result.body || !result.body.length) {
      throw new Error('小程序码返回为空')
    }

    if ((result.contentType || '').includes('json')) {
      const payload = result.body || {}
      const errCode = payload.errcode
      if (errCode) {
        throw new Error(payload.errmsg || `errcode=${errCode}`)
      }
    }

    return result.body.toString('base64')
  } catch (err) {
    logSafeError('生成微信小程序码失败', err)

    try {
      const fallback = await cloud.openapi.wxacode.getUnlimited({
        scene,
        page: pagePath,
        checkPath: false,
        envVersion: WECHAT_MINIPROGRAM_QR_ENV_VERSION,
        width: 280
      })

      if (!fallback || !fallback.buffer) {
        return ''
      }

      return fallback.buffer.toString('base64')
    } catch (fallbackErr) {
      logSafeError('OpenAPI fallback 失败', fallbackErr)
      return ''
    }
  }
}

async function createAppointmentQrCode(data = {}) {
  const { OPENID } = cloud.getWXContext()
  const scene = String(data.scene || '').trim()
  const appointmentId = String(data.appointment_id || '').trim()

  if (!OPENID || !appointmentId) {
    return buildErrorResult('无权生成预约码', 'PERMISSION_DENIED')
  }

  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(scene)) {
    return buildErrorResult('预约码格式异常', 'SESSION_CORRUPTED')
  }

  try {
    const appointmentRes = await db.collection('appointments').doc(appointmentId).get()
    const appointment = appointmentRes && appointmentRes.data
    const ownsScene = appointment && (
      appointment.qr_scene === scene ||
      (!appointment.qr_scene && appointment.verify_code === scene)
    )
    if (!appointment || appointment.patient_openid !== OPENID || !ownsScene) {
      return buildErrorResult('无权生成预约码', 'PERMISSION_DENIED')
    }
  } catch (err) {
    return buildErrorResult('预约信息校验失败', 'PERMISSION_DENIED')
  }

  const safeAppointmentId = /^[a-zA-Z0-9_-]{1,64}$/.test(appointmentId)
    ? appointmentId
    : scene

  try {
    const accessToken = await getWechatAccessToken()
    const codeUrl = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`
    const result = await requestWechatJson(codeUrl, 'POST', {
      scene,
      page: 'pages/tech-home/tech-home',
      check_path: false,
      env_version: WECHAT_MINIPROGRAM_QR_ENV_VERSION,
      width: 280
    })

    if (!result || !result.body || !result.body.length) {
      throw new Error('小程序码返回为空')
    }

    const uploadRes = await cloud.uploadFile({
      cloudPath: `qrcodes/${safeAppointmentId}-${scene}.jpg`,
      fileContent: result.body
    })

    return buildSuccessResult({ file_id: uploadRes.fileID })
  } catch (err) {
    logSafeError('生成预约小程序码失败', err)
    return buildErrorResult('二维码生成失败，请稍后重试', 'SESSION_CORRUPTED')
  }
}

async function confirmLoginSession(data) {
  const sessionId = getScanSessionIdFromRequest(data)
  if (!sessionId) {
    return buildErrorResult('会话标识不合法', 'SESSION_CORRUPTED')
  }
  const now = Date.now()

  const markRejected = async (reason, status = 'rejected') => {
    try {
      await db.collection('login_sessions').doc(sessionId).update({
        data: {
          status,
          reject_reason: reason,
          rejected_at: now,
          updated_at: now
        }
      })
    } catch (err) {
      logSafeError('标记扫码会话状态失败', err)
    }
  }

  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) {
    await markRejected('无法获取微信身份')
    return buildErrorResult('无法获取用户身份', 'SESSION_CORRUPTED')
  }

  try {
    const session = await db.collection('login_sessions').doc(sessionId).get()
    const sessionData = session.data

    if (!sessionData) {
      await markRejected('会话不存在')
      return buildErrorResult('登录会话不存在', 'SESSION_CORRUPTED')
    }

    if (sessionData.status !== 'pending') {
      await markRejected('会话已使用或过期', sessionData.status || 'rejected')
      return buildErrorResult('该登录会话已使用或过期', 'SESSION_CORRUPTED')
    }

    if (Date.now() > Number(sessionData.session_expire_at || sessionData.expires_at || 0)) {
      await markRejected('登录会话已过期')
      await db.collection('login_sessions').doc(sessionId).update({
        data: {
          status: 'expired',
          reject_reason: '登录会话已过期',
          expired_at: now,
          updated_at: Date.now()
        }
      })
      return buildErrorResult('登录会话已过期', 'SESSION_CORRUPTED')
    }

    if (sessionData.type === 'admin_bind') {
      return await confirmAdminBindSession(sessionId, sessionData, openid, markRejected)
    }

    return await confirmAdminLoginSession(sessionId, openid, markRejected)
  } catch (err) {
    logSafeError('确认扫码会话失败', err)
    await markRejected('确认失败，请刷新二维码重试')
    return buildErrorResult('确认失败，请刷新二维码重试', 'SESSION_CORRUPTED')
  }
}

async function confirmAdminLoginSession(sessionId, openid, markRejected) {
  let adminUser
  let adminRole = ''

  try {
    const adminUserRes = await db.collection('admin_users')
      .where({ openid, status: 'active' })
      .get()

    if (!adminUserRes.data || adminUserRes.data.length === 0) {
      await markRejected('该微信未绑定或账号已停用')
      return buildErrorResult('无权限访问管理后台，请先在管理员账号中绑定微信', 'SESSION_CORRUPTED')
    }
    adminUser = adminUserRes.data[0]
    adminRole = normalizeAdminRole(adminUser.role, '')
    if (!adminRole) {
      await markRejected('管理员角色配置异常')
      return buildErrorResult('该管理员角色配置异常', 'ROLE_MISMATCH')
    }
  } catch (err) {
    await markRejected('未查询到管理员绑定配置')
    return buildErrorResult('无权限访问管理后台，请先在管理员账号中绑定微信', 'SESSION_CORRUPTED')
  }

  await db.collection('login_sessions').doc(sessionId).update({
    data: {
      status: 'confirmed',
      type: 'admin_login',
      openid,
      admin_user_id: adminUser._id,
      admin_username: adminUser.username || '',
      admin_role: adminRole,
      admin_permissions: getRolePermissions(adminRole),
      confirmed_at: Date.now(),
      updated_at: Date.now()
    }
  })

  return buildSuccessResult({
    message: '确认登录成功',
    type: 'admin_login',
    status: 'confirmed',
    session_id: sessionId,
    admin_username: adminUser.username || '',
    admin_user_id: adminUser._id,
    role: adminRole,
    permissions: getRolePermissions(adminRole),
    admin_permissions: getRolePermissions(adminRole),
    tenant_scope: DEFAULT_TENANT_SCOPE
  })
}

async function confirmAdminBindSession(sessionId, session, openid, markRejected) {
  if (!session.admin_user_id) {
    await markRejected('绑定会话缺少管理员账号')
    return buildErrorResult('绑定会话异常，请重新生成二维码', 'SESSION_CORRUPTED')
  }

  const targetRes = await db.collection('admin_users').doc(session.admin_user_id).get()
  if (!targetRes.data) {
    await markRejected('管理员账号不存在')
    return buildErrorResult('管理员账号不存在', 'SESSION_CORRUPTED')
  }

  if (targetRes.data.status && targetRes.data.status !== 'active') {
    await markRejected('管理员账号已停用')
    return buildErrorResult('管理员账号已停用，不能绑定微信', 'SESSION_CORRUPTED')
  }

  const adminRole = normalizeAdminRole(targetRes.data.role, '')
  if (!adminRole) {
    await markRejected('管理员角色配置异常')
    return buildErrorResult('该管理员角色配置异常', 'ROLE_MISMATCH')
  }

  const existing = await db.collection('admin_users')
    .where({
      openid,
      _id: _.neq(session.admin_user_id)
    })
    .get()

  if (existing.data.length > 0) {
    await markRejected('该微信已绑定其他管理员账号')
    return buildErrorResult('该微信已绑定其他管理员账号，请先解绑后重试', 'SESSION_CORRUPTED')
  }

  await db.collection('admin_users').doc(session.admin_user_id).update({
    data: {
      openid,
      bound_at: db.serverDate(),
      updated_at: db.serverDate()
    }
  })

  await db.collection('login_sessions').doc(sessionId).update({
    data: {
      status: 'confirmed',
      type: 'admin_bind',
      openid,
      admin_role: adminRole,
      admin_permissions: getRolePermissions(adminRole),
      confirmed_at: Date.now(),
      updated_at: Date.now()
    }
  })

  await writeAdminAuditLog({
    admin_user_id: session.admin_user_id,
    username: targetRes.data.username,
    role: adminRole,
    tenant_scope: DEFAULT_TENANT_SCOPE
  }, 'admin.bind_wechat', {
    targetType: 'admin_user',
    targetId: session.admin_user_id,
    status: 'success',
    message: '管理员微信绑定成功'
  })

  return buildSuccessResult({
    message: '微信绑定成功',
    type: 'admin_bind',
    status: 'confirmed',
    session_id: sessionId,
    admin_user_id: session.admin_user_id
  })
}

async function checkLoginSession(data) {
  const sessionId = getScanSessionIdFromRequest(data)
  if (!sessionId) {
    return buildErrorResult('会话标识不合法', 'SESSION_CORRUPTED')
  }

  const now = Date.now()

  try {
    const session = await db.collection('login_sessions').doc(sessionId).get()
    const sessionData = session.data

    if (!sessionData) {
      return buildErrorResult('会话不存在', 'SESSION_CORRUPTED')
    }

    if (!hasValidScanBrowserSecret(data, sessionData)) {
      return buildErrorResult('会话校验失败，请刷新二维码重试', 'SESSION_CORRUPTED')
    }

    const sessionExpireAt = Number(sessionData.session_expire_at || sessionData.expires_at || 0)

    if (sessionData.status === 'logged_in' && (!sessionExpireAt || now > sessionExpireAt)) {
      await db.collection('login_sessions').doc(sessionId).update({
        data: {
          status: 'expired',
          reject_reason: '登录会话已过期',
          expired_at: now,
          updated_at: now
        }
      })
      return buildSuccessResult(buildScanSessionResponse(sessionId, {
        status: 'expired',
        type: normalizeLoginSessionType(sessionData.type),
        session_expire_at: sessionExpireAt,
        reason: sessionData.reject_reason || '',
        reject_reason: sessionData.reject_reason || ''
      }))
    }

    if (Date.now() > sessionExpireAt && sessionData.status !== 'logged_in') {
      await db.collection('login_sessions').doc(sessionId).update({
        data: {
          status: 'expired',
          reject_reason: '登录会话已过期',
          expired_at: now,
          updated_at: now
        }
      })
      return buildSuccessResult(buildScanSessionResponse(sessionId, {
        status: 'expired',
        type: normalizeLoginSessionType(sessionData.type),
        session_expire_at: sessionExpireAt,
        reason: sessionData.reject_reason || '',
        reject_reason: sessionData.reject_reason || ''
      }))
    }

    return buildSuccessResult(buildScanSessionResponse(sessionId, {
      status: sessionData.status,
      status_text: sessionData.status,
      type: normalizeLoginSessionType(sessionData.type),
      token: sessionData.status === 'logged_in' ? (sessionData.admin_token || '') : '',
      admin_user_id: sessionData.admin_user_id || '',
      admin_id: sessionData.admin_user_id || '',
      admin_username: sessionData.admin_username || '',
      role: normalizeAdminRole(sessionData.admin_role || sessionData.role || '', ''),
      tenant_scope: sessionData.tenant_scope || DEFAULT_TENANT_SCOPE,
      admin_permissions: sessionData.admin_permissions || [],
      permissions: sessionData.admin_permissions || ((sessionData.admin_role || sessionData.role)
        ? getRolePermissions(normalizeAdminRole(sessionData.admin_role || sessionData.role || '', ''))
        : []),
      reason: sessionData.reject_reason || '',
      reject_reason: sessionData.reject_reason || '',
      session_expire_at: sessionExpireAt,
      session_id: sessionId
    }))
  } catch (err) {
    logSafeError('查询扫码会话失败', err)
    return buildErrorResult('查询失败，请刷新二维码重试', 'SESSION_CORRUPTED')
  }
}

async function scanLogin(data) {
  const sessionId = getScanSessionIdFromRequest(data)
  if (!sessionId) {
    return buildErrorResult('会话标识不合法', 'SESSION_CORRUPTED')
  }

  try {
    const sessionRes = await db.collection('login_sessions').doc(sessionId).get()
    const session = sessionRes.data
    const now = Date.now()
    const sessionExpireAt = Number(session && (session.session_expire_at || session.expires_at || 0))

    if (!session) {
      return buildErrorResult('会话不存在', 'SESSION_CORRUPTED')
    }

    if (!hasValidScanBrowserSecret(data, session)) {
      return buildErrorResult('会话校验失败，请刷新二维码重试', 'SESSION_CORRUPTED')
    }

    if (session.status === 'rejected') {
      return buildErrorResult('会话已被拒绝', 'SESSION_CORRUPTED')
    }

    if (session.status === 'logged_in' && (!sessionExpireAt || now > sessionExpireAt)) {
      await db.collection('login_sessions').doc(sessionId).update({
        data: {
          status: 'expired',
          reject_reason: '登录会话已过期',
          expired_at: now,
          updated_at: now
        }
      })
      return buildErrorResult('登录会话已过期', 'SESSION_CORRUPTED')
    }

    if (session.status === 'logged_in' && session.admin_token) {
      const sessionRole = normalizeAdminRole(session.admin_role || session.role || '', '')
      if (!sessionRole) {
        return buildErrorResult('登录会话角色异常', 'ROLE_MISMATCH')
      }

      return buildSuccessResult({
        status: 'logged_in',
        session_id: sessionId,
        type: 'admin_login',
        token: session.admin_token,
        username: session.admin_username || '',
        role: sessionRole,
        permissions: getRolePermissions(sessionRole),
        admin_permissions: getRolePermissions(sessionRole),
        tenant_scope: session.tenant_scope || DEFAULT_TENANT_SCOPE,
        session_expire_at: sessionExpireAt,
        expires_at: sessionExpireAt,
        admin_id: session.admin_user_id || '',
        admin_user_id: session.admin_user_id || ''
      })
    }

    if (session.type && session.type !== 'admin_login') {
      return buildErrorResult('该二维码不是登录二维码，请刷新后重试', 'SESSION_CORRUPTED')
    }

    if (session.status !== 'confirmed') {
      return buildErrorResult('会话未确认或已过期', 'SESSION_CORRUPTED')
    }

    if (!sessionExpireAt || Date.now() > sessionExpireAt) {
      await db.collection('login_sessions').doc(sessionId).update({
        data: {
          status: 'expired',
          reject_reason: '登录会话已过期',
          expired_at: Date.now(),
          updated_at: Date.now()
        }
      })
      return buildErrorResult('会话已过期', 'SESSION_CORRUPTED')
    }

    const adminRes = await db.collection('admin_users')
      .where({ openid: session.openid })
      .limit(1)
      .get()

    if (!adminRes.data || adminRes.data.length === 0) {
      return buildErrorResult('该微信未绑定管理员账号', 'SESSION_CORRUPTED')
    }

    const adminUser = adminRes.data[0]
    if (adminUser.status && adminUser.status !== 'active') {
      return buildErrorResult('管理员账号已停用', 'SESSION_CORRUPTED')
    }

    const role = normalizeAdminRole(adminUser.role, '')
    if (!role) {
      return buildErrorResult('管理员角色配置异常', 'ROLE_MISMATCH')
    }

    const token = await createAdminSession({
      admin_user_id: adminUser._id,
      username: adminUser.username || '',
      role,
      openid: adminUser.openid || session.openid,
      login_method: 'scan'
    })

    const loginSessionExpireAt = Date.now() + ADMIN_SESSION_TTL_MS
    await db.collection('login_sessions').doc(sessionId).update({
      data: {
        status: 'logged_in',
        admin_token: token,
        admin_username: adminUser.username || '',
        admin_role: role,
        admin_user_id: adminUser._id,
        admin_openid: adminUser.openid || session.openid,
        admin_permissions: getRolePermissions(role),
        tenant_scope: DEFAULT_TENANT_SCOPE,
        session_expire_at: loginSessionExpireAt,
        logged_in_at: Date.now(),
        updated_at: Date.now()
      }
    })

    await writeAdminAuditLog({
      admin_user_id: adminUser._id,
      username: adminUser.username,
      role,
      tenant_scope: DEFAULT_TENANT_SCOPE
    }, 'admin.login.scan', {
      targetType: 'admin_user',
      targetId: adminUser._id,
      status: 'success',
      message: '扫码登录成功'
    })

      return buildSuccessResult({
        message: '扫码登录成功',
        status: 'logged_in',
        session_id: sessionId,
        type: 'admin_login',
        session_expire_at: loginSessionExpireAt,
        expires_at: loginSessionExpireAt,
        token,
        username: adminUser.username || '',
        role,
        permissions: getRolePermissions(role),
        admin_permissions: getRolePermissions(role),
        admin_id: adminUser._id,
        admin_user_id: adminUser._id,
        tenant_scope: DEFAULT_TENANT_SCOPE
      })
  } catch (err) {
    logSafeError('兑换扫码登录会话失败', err)
    return buildErrorResult('登录失败，请刷新二维码重试', 'SESSION_CORRUPTED')
  }
}

// ==================== 管理员账号管理 ====================

async function getCurrentAdmin(adminAuth = {}) {
  if (!adminAuth || !adminAuth.admin_user_id) {
    return buildErrorResult('身份验证失败，请重新登录', 'TOKEN_EXPIRED')
  }

  const session = adminAuth
  return buildSuccessResult({
    username: session.username || '管理员',
    role: session.role,
    openid: session.openid || '',
    permissions: session.permissions || [],
    admin_permissions: session.permissions || [],
    admin_id: session.admin_user_id,
    tenant_scope: session.tenant_scope || DEFAULT_TENANT_SCOPE,
    session_expire_at: session.session_expire_at || 0,
    last_login_at: session.last_login_at || 0
  })
}

async function getAdminAuditLogs(adminAuth = {}, data = {}) {
  if (!adminAuth || adminAuth.role !== 'super_admin') {
    return buildErrorResult('当前账号无权限访问审计日志', 'INSUFFICIENT_PERMISSION')
  }

  const page = normalizePagination(data && data.page, 1, 200)
  const pageSize = normalizePagination(data && data.page_size, 20, 200)

  const filters = {}
  if (data && data.admin_user_id) {
    filters.admin_user_id = data.admin_user_id
  }
  if (data && data.action) {
    filters.action = data.action
  }
  if (data && data.target_type) {
    filters.target_type = data.target_type
  }
  if (data && data.target_id) {
    filters.target_id = data.target_id
  }

  let query = db.collection('admin_audit_logs')
  let countQuery = db.collection('admin_audit_logs')
  Object.keys(filters).forEach((key) => {
    query = query.where({ [key]: filters[key] })
    countQuery = countQuery.where({ [key]: filters[key] })
  })

  const countRes = await countQuery.count()
  const total = Number(countRes.total || 0)

  const listRes = await query
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  return buildSuccessResult({
    list: (listRes.data || []).map(item => {
      const safe = { ...item, changes: sanitizeAuditChanges(item.changes) }
      delete safe.openid
      return safe
    }),
    total,
    page,
    page_size: pageSize
  })
}

async function getAdminUsers(adminAuth = {}) {
  const res = await db.collection('admin_users')
    .where({ status: _.neq('deleted') })
    .orderBy('created_at', 'desc')
    .get()

  return buildSuccessResult(
    res.data
      .map(sanitizeAdminUser)
      .map(user => ({
        ...user,
        last_login_at: user.last_login_at || 0
      }))
  )
}

async function addAdminUser(adminAuth = {}, data = {}) {
  if (!data || typeof data !== 'object') {
    return buildErrorResult('参数无效', 'SESSION_CORRUPTED')
  }

  const username = (data.username || '').trim()
  const password = (data.password || '').trim()
  const role = normalizeAdminRole(typeof data.role === 'string' ? data.role : '', '')
  const openid = (data.openid || '').trim()

  if (!username) {
    return buildErrorResult('请输入登录账号', 'SESSION_CORRUPTED')
  }
  if (username.length > 64) {
    return buildErrorResult('管理员账号长度不能超过64', 'SESSION_CORRUPTED')
  }
  if (!password) {
    return buildErrorResult('请输入登录密码', 'SESSION_CORRUPTED')
  }
  if (!isStrongAdminPassword(password)) {
    return buildErrorResult('密码至少8位，且需同时包含字母和数字', 'SESSION_CORRUPTED')
  }
  if (!role) {
    return buildErrorResult('管理员角色无效', 'SESSION_CORRUPTED')
  }

  const existing = await db.collection('admin_users').where({ username }).get()
  if (existing.data.length > 0) {
    return buildErrorResult('账号名称已存在', 'SESSION_CORRUPTED')
  }

  if (openid) {
    const existingOpenid = await db.collection('admin_users').where({ openid }).get()
    if (existingOpenid.data.length > 0) {
      return buildErrorResult('该微信已绑定其他管理员账号', 'SESSION_CORRUPTED')
    }
  }

  const res = await db.collection('admin_users').add({
    data: {
      username,
      password_hash: hashAdminPassword(password),
      openid,
      role,
      name: (data.name || '').trim(),
      remark: (data.remark || '').trim(),
      status: 'active',
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    }
  })

  await writeAdminAuditLog(adminAuth, 'admin.add', {
    targetType: 'admin_user',
    targetId: res._id,
    status: 'success',
    message: '新增管理员账号'
  })

  return buildSuccessResult({ message: '添加成功', _id: res._id })
}

async function updateAdminUser(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少 id', 'SESSION_CORRUPTED')
  }

  const updateData = {}
  const sessionInvalidateReasons = []

  if (typeof data.username === 'string') {
    const username = data.username.trim()
    if (!username) {
      return buildErrorResult('登录账号不能为空', 'SESSION_CORRUPTED')
    }
    if (username.length > 64) {
      return buildErrorResult('管理员账号长度不能超过64', 'SESSION_CORRUPTED')
    }

    const existing = await db.collection('admin_users')
      .where({
        username,
        _id: _.neq(data.id)
      })
      .get()

    if (existing.data.length > 0) {
      return buildErrorResult('账号名称已存在', 'SESSION_CORRUPTED')
    }

    updateData.username = username
  }

  if (typeof data.password === 'string' && data.password.trim()) {
    const password = data.password.trim()
    if (!isStrongAdminPassword(password)) {
      return buildErrorResult('密码至少8位，且需同时包含字母和数字', 'SESSION_CORRUPTED')
    }
    updateData.password_hash = hashAdminPassword(password)
  }

  if (typeof data.role === 'string') {
    const role = normalizeAdminRole(data.role, '')
    if (!role) {
      return buildErrorResult('管理员角色无效', 'SESSION_CORRUPTED')
    }
    if (adminAuth.admin_user_id === data.id && role !== adminAuth.role) {
      return buildErrorResult('不能直接修改当前登录账号的角色', 'SESSION_CORRUPTED')
    }
    updateData.role = role
    sessionInvalidateReasons.push('角色已变更')
  }

  if (typeof data.openid === 'string') {
    const openid = data.openid.trim()
    if (openid) {
      const existingOpenid = await db.collection('admin_users')
        .where({
          openid,
          _id: _.neq(data.id)
        })
        .get()
      if (existingOpenid.data.length > 0) {
        return buildErrorResult('该微信已绑定其他管理员账号', 'SESSION_CORRUPTED')
      }
    }
    updateData.openid = openid
    sessionInvalidateReasons.push('微信绑定信息已变更')
  }

  if (typeof data.name === 'string') {
    if (data.name.trim().length > 64) {
      return buildErrorResult('姓名长度不能超过64', 'SESSION_CORRUPTED')
    }
    updateData.name = data.name.trim()
  }

  if (typeof data.remark === 'string') {
    if (data.remark.trim().length > 300) {
      return buildErrorResult('备注长度不能超过300', 'SESSION_CORRUPTED')
    }
    updateData.remark = data.remark.trim()
  }

  if (typeof data.status === 'string' && ['active', 'inactive'].includes(data.status)) {
    if (adminAuth.admin_user_id === data.id && data.status !== 'active') {
      return buildErrorResult('不能停用当前登录账号', 'SESSION_CORRUPTED')
    }
    updateData.status = data.status
    sessionInvalidateReasons.push('账号状态已变更')
  } else if (typeof data.status === 'string') {
    return buildErrorResult('管理员状态不合法', 'SESSION_CORRUPTED')
  }

  if (Object.keys(updateData).length === 0) {
    return buildSuccessResult({ message: '未修改任何字段' })
  }

  updateData.updated_at = db.serverDate()
  await db.collection('admin_users').doc(data.id).update({
    data: updateData
  })

  if (sessionInvalidateReasons.length > 0) {
    const invalidated = await invalidateAdminSessionsByUser(data.id, sessionInvalidateReasons[0])
    if (invalidated > 0) {
      writeAdminAuditLog(adminAuth, 'admin.invalidate_session', {
        targetType: 'admin_user',
        targetId: data.id,
        status: 'success',
        changes: {
          reasons: sessionInvalidateReasons,
          count: invalidated
        },
        message: '管理员关键字段变更，已失效历史会话'
      }).catch(() => {})
    }
  }

  await writeAdminAuditLog(adminAuth, 'admin.update', {
    targetType: 'admin_user',
    targetId: data.id,
    changes: updateData,
    status: 'success',
    message: '更新管理员账号'
  })

  return buildSuccessResult({ message: '更新成功' })
}

async function removeAdminUser(adminAuth = {}, data = {}) {
  if (!data || !data.id) {
    return buildErrorResult('缺少 id', 'SESSION_CORRUPTED')
  }

  if (adminAuth.admin_user_id === data.id) {
    return buildErrorResult('不能删除当前登录账号', 'SESSION_CORRUPTED')
  }

  const target = await db.collection('admin_users').doc(data.id).get()
  if (!target.data) {
    return buildErrorResult('管理员账号不存在', 'SESSION_CORRUPTED')
  }

  if (target.data.role === 'super_admin' && target.data.status !== 'deleted') {
    const activeSuperAdminRes = await db.collection('admin_users')
      .where({ role: 'super_admin', status: 'active' })
      .count()

    if ((activeSuperAdminRes.total || 0) <= 1) {
      return buildErrorResult('不能删除唯一的超级管理员', 'SESSION_CORRUPTED')
    }
  }

  await db.collection('admin_users')
    .doc(data.id)
    .update({
      data: {
        status: 'deleted',
        deleted_at: db.serverDate(),
        deleted_by: adminAuth.admin_user_id || '',
        openid: '',
        updated_at: db.serverDate()
      }
    })

  await invalidateAdminSessionsByUser(data.id, '管理员账号已被删除')
  writeAdminAuditLog(adminAuth, 'admin.invalidate_session', {
    targetType: 'admin_user',
    targetId: data.id,
    status: 'success',
    message: '管理员账号已删除，已失效历史会话'
  }).catch(() => {})

  await writeAdminAuditLog(adminAuth, 'admin.remove', {
    targetType: 'admin_user',
    targetId: data.id,
    status: 'success',
    message: '删除管理员账号'
  })

  return buildSuccessResult({ message: '删除成功' })
}
