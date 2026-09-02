export const ROLE_LABELS = {
  super_admin: '超级管理员',
  manager: '门店管理员',
  viewer: '查看员'
}

export const ROLE_OPTIONS = [
  { value: 'super_admin', label: ROLE_LABELS.super_admin },
  { value: 'manager', label: ROLE_LABELS.manager },
  { value: 'viewer', label: ROLE_LABELS.viewer }
]

const ROUTE_ROLE_MAP = {
  '/': ['super_admin', 'manager', 'viewer'],
  '/appointments': ['super_admin', 'manager', 'viewer'],
  '/customers': ['super_admin', 'manager', 'viewer'],
  '/commissions': ['super_admin', 'manager', 'viewer'],
  '/articles': ['super_admin', 'manager'],
  '/services': ['super_admin', 'manager'],
  '/technicians': ['super_admin', 'manager'],
  '/rest-management': ['super_admin', 'manager'],
  '/business-config': ['super_admin', 'manager'],
  '/admin-users': ['super_admin'],
  '/audit-logs': ['super_admin']
}

const SESSION_KEY = 'admin_session'
const LEGACY_INFO_KEY = 'admin_info'
const SESSION_STORAGE_KEYS = ['admin_session', 'admin_info', 'admin_loggedin', 'admin_token', 'admin_password']
const SESSION_EXPIRY_GRACE_MS = 5 * 1000
const TRAILING_SLASH_RE = /\/+$/g

function normalizeSessionRole(role) {
  return ROLE_OPTIONS.some(item => item.value === role) ? role : ''
}

function normalizePermissionScope(scope = '') {
  return scope || 'single_store'
}

function normalizePermissions(permissions = []) {
  if (!Array.isArray(permissions)) {
    return []
  }
  return permissions.filter(item => typeof item === 'string')
}

function readAdminSession() {
  const raw = sessionStorage.getItem(SESSION_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      return parsed || {}
    } catch {
      // ignore
    }
  }

  // 兼容旧会话：支持历史版本只存 admin_info/admin_token 的场景
  const legacyRaw = sessionStorage.getItem(LEGACY_INFO_KEY)
  const legacyToken = sessionStorage.getItem('admin_token')
  if (!legacyRaw && !legacyToken) {
    return {}
  }

  try {
    const legacyInfo = legacyRaw ? JSON.parse(legacyRaw) : {}
    return {
      token: legacyToken || '',
      username: legacyInfo.username || '',
      role: normalizeSessionRole(legacyInfo.role || ''),
      admin_id: legacyInfo.admin_id || '',
      tenant_scope: normalizePermissionScope(legacyInfo.tenant_scope),
      permissions: normalizePermissions(legacyInfo.permissions),
      session_expire_at: Number(legacyInfo.session_expire_at || 0),
      last_login_at: Number(legacyInfo.last_login_at || 0)
    }
  } catch {
    return legacyToken ? { token: legacyToken } : {}
  }
}

export function getAdminSession() {
  return readAdminSession()
}

export function getAdminInfo() {
  const session = getAdminSession()
  return {
    username: session.username || '',
    role: session.role || '',
    admin_id: session.admin_id || '',
    tenant_scope: session.tenant_scope || 'single_store',
    permissions: session.permissions || [],
    token: session.token || '',
    session_expire_at: session.session_expire_at || 0,
    last_login_at: session.last_login_at || 0
  }
}

export function setAdminSession(session = {}) {
  const next = {
    token: session.token || '',
    admin_id: session.admin_id || session.admin_user_id || '',
    username: session.username || '',
    role: normalizeSessionRole(session.role || ''),
    permissions: normalizePermissions(session.permissions || session.permission || []),
    tenant_scope: normalizePermissionScope(session.tenant_scope || 'single_store'),
    session_expire_at: Number(session.session_expire_at || session.expires_at || 0),
    last_login_at: Number(session.last_login_at || Date.now()),
    updated_at: Number(session.updated_at || Date.now())
  }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(next))
  // 保持兼容：同步已有字段
  sessionStorage.setItem('admin_token', next.token)
  sessionStorage.setItem('admin_loggedin', String(Boolean(next.token && next.role)))
  setAdminInfo(next)
  return next
}

export function setAdminInfo(info = {}) {
  sessionStorage.setItem(LEGACY_INFO_KEY, JSON.stringify(info))
}

export function clearAdminInfo() {
  SESSION_STORAGE_KEYS.forEach(key => {
    sessionStorage.removeItem(key)
  })
}

export function getAdminRole() {
  return getAdminInfo().role || ''
}

export function isSessionExpired(session = getAdminSession()) {
  if (!session || !session.session_expire_at) {
    return true
  }
  return (Date.now() - SESSION_EXPIRY_GRACE_MS) > Number(session.session_expire_at)
}

export function isSessionExpiringSoon(session = getAdminSession(), thresholdMs = 60 * 1000) {
  if (!session || !session.session_expire_at) {
    return true
  }
  return Number(session.session_expire_at) - Date.now() <= thresholdMs
}

export function isKnownRole(role = getAdminRole()) {
  return ROLE_LABELS[role] === undefined ? false : true
}

export function getRoleLabel(role) {
  return ROLE_LABELS[role] || '未登录'
}

export function hasRoutePermission(path, role = getAdminRole()) {
  if (!role) {
    return false
  }

  const normalizedPath = String(path || '/').replace(TRAILING_SLASH_RE, '') || '/'
  const allowedRoles = ROUTE_ROLE_MAP[normalizedPath]
  if (!allowedRoles) {
    return false
  }

  return allowedRoles.includes(role)
}

export function getRolePermissions(role = getAdminRole()) {
  return {
    super_admin: ['*'],
    manager: [
      'getServices', 'createService', 'updateService',
    'getTechnicians', 'createTechnician', 'updateTechnician', 'toggleTechnicianStatus', 'deleteTechnician',
    'getCustomers', 'updateCustomer', 'deleteCustomer', 'toggleBlacklist',
    'getAppointments', 'getAppointmentDetail',
    'getHolidays', 'addHoliday', 'deleteHoliday',
    'getTechDaysOff', 'addTechDayOff', 'deleteTechDayOff',
    'getCommissions', 'getCommissionSummary',
    'getArticles', 'createArticle', 'updateArticle', 'toggleArticleStatus', 'deleteArticle',
    'updateConfig', 'importHolidays',
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
  }[role] || []
}

export function hasActionPermission(action, role = getAdminRole()) {
  const permissions = getRolePermissions(role)
  return permissions.includes('*') || permissions.includes(action)
}

export function isKnownSession(session = getAdminSession()) {
  return Boolean(session && session.token && session.role && !isSessionExpired(session))
}
