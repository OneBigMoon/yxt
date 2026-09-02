import app from './cloudbase'
import {
  clearAdminInfo,
  getAdminSession,
  setAdminSession
} from '../utils/permissions'

let loginPromise = null

const NETWORK_HINT = '云函数网络请求失败，请确认匿名登录已开启、admin 云函数已部署、当前域名已加入云开发 Web 安全域名'
const ERROR_CODE_TEXT = {
  TOKEN_EXPIRED: '会话已过期，请重新登录',
  SESSION_EXPIRED: '会话已过期，请重新登录',
  ROLE_MISMATCH: '账号角色异常，请重新登录',
  INSUFFICIENT_PERMISSION: '当前账号无权限访问该功能',
  USER_DISABLED: '账号已停用，请联系管理员'
}

const TRACE_ID_LENGTH = 12
const AUTH_ERROR_CODES = new Set([
  'TOKEN_EXPIRED',
  'SESSION_EXPIRED',
  'ROLE_MISMATCH',
  'INSUFFICIENT_PERMISSION',
  'USER_DISABLED'
])

function getResultErrorCode(result) {
  if (!result || typeof result !== 'object') {
    return ''
  }
  return String(result.error_code || result.errorCode || '')
}

function isAuthErrorCode(code) {
  return AUTH_ERROR_CODES.has(code)
}

function mapNetworkError(err) {
  const message = (err && err.message) ? String(err.message) : ''
  if (message.includes('network request error') || message.includes('Network Error') || message.includes('NETWORK_ERR') || message.includes('timeout')) {
    const netErr = new Error(NETWORK_HINT)
    netErr.code = -1000
    return netErr
  }

  if (message.includes('ECONNRESET') || message.includes('ENOTFOUND') || message.includes('request error')) {
    const netErr = new Error(NETWORK_HINT)
    netErr.code = -1000
    return netErr
  }

  return err
}

function generateTraceId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < TRACE_ID_LENGTH; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return id
}

function notifyAuthInvalid(err) {
  if (typeof window === 'undefined') {
    return
  }

  const code = err && (err.error_code || err.errorCode || '')
  const message = err && err.message ? String(err.message) : ''
  window.dispatchEvent(new CustomEvent('admin:auth-invalid', {
    detail: { code, message }
  }))
}

async function ensureLogin() {
  if (loginPromise) {
    return loginPromise
  }

  const auth = app.auth()
  loginPromise = (async () => {
    const hasLoginState = await auth.hasLoginState()
    if (hasLoginState) {
      return
    }

    return auth.signInAnonymously().catch((err) => {
      console.error('匿名登录失败:', err)
      loginPromise = null
      throw new Error('云开发匿名登录失败，请在云开发控制台开启匿名登录，并确认当前域名已允许访问')
    })
  })()

  return loginPromise
}

function buildError(action, result) {
  const code = getResultErrorCode(result)
  const message = (result && result.message) || '请求失败'
  const err = new Error(ERROR_CODE_TEXT[code] || message)
  err.name = 'AdminCloudError'
  err.code = Number(result && result.code) || -1
  err.error_code = code
  err.action = action
  err.trace_id = result && result.trace_id
  return err
}

function getRequestSession() {
  const session = getAdminSession()
  if (!session || !session.token) {
    return null
  }

  return {
    token: session.token,
    role: session.role,
    permissions: session.permissions || [],
    admin_id: session.admin_id,
    session_expire_at: session.session_expire_at,
    last_login_at: session.last_login_at,
    tenant_scope: session.tenant_scope || 'single_store'
  }
}

function applyRemoteSession(session = {}) {
  if (!session || !session.token) {
    return
  }
  setAdminSession({
    ...getAdminSession(),
    ...session
  })
}

function isAuthError(err) {
  const code = err && err.error_code ? err.error_code : ''
  return isAuthErrorCode(code)
}

function normalizeAuthError(err) {
  return (err && (err.message || ''))
    .toString()
    .includes('身份验证')
    || (err && err.message && err.message.includes('登录会话'))
}

async function callAdmin(action, data = {}) {
  await ensureLogin()

  const traceId = generateTraceId()
  const adminSession = getRequestSession()
  try {
    const res = await app.callFunction({
      name: 'admin',
      data: {
        action,
        data,
        admin_session: adminSession,
        admin_token: adminSession ? adminSession.token : '',
        trace_id: traceId
      }
    })

    if (!res || !res.result) {
      throw new Error('云函数返回异常')
    }

    if (typeof res.result.code === 'undefined') {
      throw new Error('云函数返回格式异常')
    }

    if (res.result.code !== 0) {
      throw buildError(action, res.result)
    }

    if (res.result.data && (res.result.data.admin_id || res.result.data.token)) {
      applyRemoteSession(res.result.data)
    }

    return res.result.data
  } catch (err) {
    let normalized = mapNetworkError(err)
    console.error(`调用云函数失败 [${action}]:`, normalized)

    const isAuth = isAuthError(normalized)
    const isAuthMessage = normalized && typeof normalized.message === 'string' && normalizeAuthError(normalized)

    if (isAuth || isAuthMessage) {
      clearAdminInfo()
      if (!normalized || typeof normalized !== 'object') {
        normalized = new Error('登录会话异常')
      }

      normalized.message = ERROR_CODE_TEXT[normalized.error_code] || normalized.message || '登录会话异常'
      notifyAuthInvalid(normalized)
    }

    if (normalized && normalized.error_code && ERROR_CODE_TEXT[normalized.error_code]) {
      normalized.message = ERROR_CODE_TEXT[normalized.error_code]
    }

    if (normalized && !normalized.trace_id) {
      normalized.trace_id = traceId
    }

    throw normalized
  }
}

export const authApi = {
  passwordLogin(payload) {
    const data = typeof payload === 'string'
      ? { password: payload }
      : (payload || {})
    return callAdmin('verifyAdminPassword', data)
  },
  getCurrent() {
    return callAdmin('getCurrentAdmin')
  },
  logout() {
    const session = getAdminSession()
    if (!session || !session.token) {
      clearAdminInfo()
      return Promise.resolve({})
    }

    return callAdmin('logout').finally(() => {
      clearAdminInfo()
    })
  }
}

export const auditApi = {
  getList(params = {}) {
    return callAdmin('getAdminAuditLogs', params)
  }
}

// 预约相关API
export const appointmentApi = {
  getList(params) {
    return callAdmin('getAppointments', params)
  },
  getDetail(id) {
    return callAdmin('getAppointmentDetail', { id })
  }
}

// 客户相关API
export const customerApi = {
  getList(params) {
    return callAdmin('getCustomers', params)
  },
  update(id, data) {
    return callAdmin('updateCustomer', { ...data, id })
  },
  delete(id) {
    return callAdmin('deleteCustomer', { id })
  },
  toggleBlacklist(id, isBlacklisted) {
    return callAdmin('toggleBlacklist', { id, is_blacklisted: isBlacklisted })
  }
}

// 技师相关API
export const technicianApi = {
  getList() {
    return callAdmin('getTechnicians')
  },
  create(data) {
    return callAdmin('createTechnician', data)
  },
  update(id, data) {
    return callAdmin('updateTechnician', { ...data, id })
  },
  toggleStatus(id, status) {
    return callAdmin('toggleTechnicianStatus', { id, status })
  },
  delete(id) {
    return callAdmin('deleteTechnician', { id })
  }
}

// 服务相关API
export const serviceApi = {
  getList() {
    return callAdmin('getServices')
  },
  create(data) {
    return callAdmin('createService', data)
  },
  update(id, data) {
    return callAdmin('updateService', { ...data, id })
  }
}

// 营业配置API
export const configApi = {
  get() {
    return callAdmin('getConfig')
  },
  update(data) {
    return callAdmin('updateConfig', data)
  }
}

// 休息管理API
export const restApi = {
  getHolidays(params) {
    return callAdmin('getHolidays', params)
  },
  addHoliday(data) {
    return callAdmin('addHoliday', data)
  },
  deleteHoliday(id) {
    return callAdmin('deleteHoliday', { id })
  },
  getTechDaysOff() {
    return callAdmin('getTechDaysOff')
  },
  addTechDayOff(data) {
    return callAdmin('addTechDayOff', data)
  },
  deleteTechDayOff(id) {
    return callAdmin('deleteTechDayOff', { id })
  },
  importHolidays() {
    return callAdmin('importHolidays')
  }
}

// 提成统计API
export const commissionApi = {
  getList(params) {
    return callAdmin('getCommissions', params)
  },
  getSummary(params) {
    return callAdmin('getCommissionSummary', params)
  }
}

// 文章相关API
export const articleApi = {
  getList() {
    return callAdmin('getArticles')
  },
  create(data) {
    return callAdmin('createArticle', data)
  },
  update(id, data) {
    return callAdmin('updateArticle', { ...data, id })
  },
  delete(id) {
    return callAdmin('deleteArticle', { id })
  },
  toggleStatus(id, status) {
    return callAdmin('toggleArticleStatus', { id, status })
  }
}

// 管理员账号API
export const adminUserApi = {
  getList() {
    return callAdmin('getAdminUsers')
  },
  add(data) {
    return callAdmin('addAdminUser', data)
  },
  update(id, data) {
    return callAdmin('updateAdminUser', { ...data, id })
  },
  resetPassword(id, password) {
    return callAdmin('updateAdminUser', { id, password })
  },
  updateStatus(id, status) {
    return callAdmin('updateAdminUser', { id, status })
  },
  createBindSession(id) {
    return callAdmin('createAdminBindSession', { id })
  },
  checkBindSession(sessionId) {
    return callAdmin('checkLoginSession', { session_id: sessionId })
  },
  remove(id) {
    return callAdmin('removeAdminUser', { id })
  }
}

// 文件上传 — 用云存储替代 Express multer

// 扫码登录API
export const scanLoginApi = {
  // 创建登录会话
  createSession() {
    return callAdmin('createLoginSession', { prefer_miniprogram_qr: true })
  },
  // 轮询检查会话状态
  checkSession(sessionId) {
    return callAdmin('checkLoginSession', { session_id: sessionId })
  },
  // 确认登录后获取后台会话 token
  scanLogin(sessionId) {
    return callAdmin('scanLogin', { session_id: sessionId })
  }
}

export async function uploadFile(file) {
  await ensureLogin()
  const ext = file.name.split('.').pop()
  const cloudPath = `admin-uploads/${Date.now()}.${ext}`
  const result = await app.uploadFile({
    cloudPath,
    filePath: file
  })
  const urlRes = await app.getTempFileURL({
    fileList: [result.fileID]
  })
  return urlRes.fileList[0].tempFileURL
}
