import { createRouter, createWebHashHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ROLE_LABELS,
  clearAdminInfo,
  getAdminSession,
  getAdminRole,
  hasActionPermission,
  hasRoutePermission,
  isKnownSession,
  isSessionExpiringSoon,
  setAdminSession
} from '../utils/permissions'
import { authApi } from '../api'

let sessionVerifyPromise = null
let lastVerifyAt = 0
let lastVerifyResult = null
const SESSION_VERIFY_TTL_MS = 45 * 1000
let lastSessionExpireHintAt = 0

function normalizeRoutePath(path = '') {
  if (!path) {
    return '/'
  }

  const plainPath = String(path).split('?')[0].split('#')[0]
  const normalized = plainPath.replace(/\/+$/g, '')
  return normalized || '/'
}

async function refreshAdminSession(force = false) {
  const now = Date.now()
  if (sessionVerifyPromise) {
    return sessionVerifyPromise
  }

  if (!force && lastVerifyResult && (now - lastVerifyAt) < SESSION_VERIFY_TTL_MS) {
    return lastVerifyResult
  }

  if (!isKnownSession()) {
    lastVerifyResult = null
    lastVerifyAt = now
    clearAdminInfo()
    return null
  }

  sessionVerifyPromise = (async () => {
    try {
      const info = await authApi.getCurrent()
      const current = getAdminSession()
      if (current && info) {
        setAdminSession({ ...current, ...info })
      }
      lastVerifyAt = Date.now()
      lastVerifyResult = info || null
      return info || null
    } catch (err) {
      const current = getAdminSession()
      const code = err && err.error_code ? err.error_code : ''
      const message = err && err.message ? err.message : ''
      if (code === 'TOKEN_EXPIRED' || code === 'SESSION_EXPIRED' || code === 'ROLE_MISMATCH' || code === 'INSUFFICIENT_PERMISSION' || code === 'USER_DISABLED') {
        clearAdminInfo()
        lastVerifyAt = Date.now()
        lastVerifyResult = null
        return null
      }
      if (message.includes('身份验证失败') || message.includes('登录会话')) {
        clearAdminInfo()
        lastVerifyAt = Date.now()
        lastVerifyResult = null
        return null
      }

      if (current && isKnownSession(current)) {
        lastVerifyAt = Date.now()
        lastVerifyResult = current
        return current
      }

      lastVerifyAt = Date.now()
      lastVerifyResult = null
      return null
    } finally {
      sessionVerifyPromise = null
    }
  })()

  return sessionVerifyPromise
}

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue'),
    alias: ['/login/'],
    meta: { title: '登录', public: true }
  },
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('../views/Dashboard.vue'),
    meta: { title: '仪表盘', requiredAction: 'getAppointments' }
  },
  {
    path: '/appointments',
    name: 'Appointments',
    component: () => import('../views/Appointments.vue'),
    meta: { title: '预约管理', requiredAction: 'getAppointments' }
  },
  {
    path: '/customers',
    name: 'Customers',
    component: () => import('../views/Customers.vue'),
    meta: { title: '客户管理', requiredAction: 'getCustomers' }
  },
  {
    path: '/technicians',
    name: 'Technicians',
    component: () => import('../views/Technicians.vue'),
    meta: { title: '技师管理', requiredAction: 'getTechnicians' }
  },
  {
    path: '/services',
    name: 'Services',
    component: () => import('../views/Services.vue'),
    meta: { title: '服务管理', requiredAction: 'getServices' }
  },
  {
    path: '/business-config',
    name: 'BusinessConfig',
    component: () => import('../views/BusinessConfig.vue'),
    meta: { title: '营业设置', requiredAction: 'updateConfig' }
  },
  {
    path: '/rest-management',
    name: 'RestManagement',
    component: () => import('../views/RestManagement.vue'),
    meta: { title: '休息管理', requiredAction: 'getHolidays' }
  },
  {
    path: '/commissions',
    name: 'Commissions',
    component: () => import('../views/Commissions.vue'),
    meta: { title: '提成统计', requiredAction: 'getCommissions' }
  },
  {
    path: '/articles',
    name: 'Articles',
    component: () => import('../views/Articles.vue'),
    meta: { title: '健康小知识', requiredAction: 'getArticles' }
  },
  {
    path: '/admin-users',
    name: 'AdminUsers',
    component: () => import('../views/AdminUsers.vue'),
    meta: { title: '管理员账号', requiredAction: 'getAdminUsers' }
  },
  {
    path: '/audit-logs',
    name: 'AuditLogs',
    component: () => import('../views/AuditLogs.vue'),
    meta: { title: '审计日志', requiredAction: 'getAdminAuditLogs' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    redirect: '/'
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

// 路由守卫
router.beforeEach(async (to, from, next) => {
  const routePath = normalizeRoutePath(to.path || '/')
  const isLoginPage = Boolean(to.meta && to.meta.public)
  const requiredAction = to.meta && to.meta.requiredAction
  const localSession = getAdminSession()
  const hasLocalSession = isKnownSession(localSession)
  const resolvedSession = hasLocalSession ? await refreshAdminSession() : null
  const effectiveRole = resolvedSession && resolvedSession.role ? resolvedSession.role : getAdminRole()
  const hasKnownRole = Boolean(ROLE_LABELS[effectiveRole])
  const hasAuthSession = Boolean(hasLocalSession && resolvedSession && effectiveRole)

  if (!hasKnownRole && effectiveRole) {
    clearAdminInfo()
    ElMessage.warning('登录会话异常，请重新登录')
    next('/login')
    return
  }

  if (isLoginPage) {
    if (hasAuthSession) {
      next('/')
      return
    }

    if (!hasLocalSession) {
      clearAdminInfo()
    }

    next()
    return
  }

  if (!hasAuthSession) {
    clearAdminInfo()
    ElMessage.warning('请先登录管理后台')
    next('/login')
    return
  }

  if (requiredAction && !hasActionPermission(requiredAction, effectiveRole)) {
    if (to.path !== '/') {
      ElMessage.warning('当前权限不支持该页面')
      next('/')
      return
    }
  }

  if (!hasRoutePermission(routePath, effectiveRole)) {
    if (to.path !== '/') {
      ElMessage.warning('无权限访问该页面')
      next('/')
      return
    }
  }

  const localSessionExpiring = isSessionExpiringSoon(localSession, 45 * 1000)

  if (localSessionExpiring) {
    const now = Date.now()
    if (now - lastSessionExpireHintAt > 60 * 1000) {
      ElMessage.warning('会话即将过期，请重新登录以避免操作中断')
      lastSessionExpireHintAt = now
    }
  }

  // 同步服务端最新角色/会话信息到本地缓存
  if (resolvedSession && getAdminRole() !== resolvedSession.role) {
    setAdminSession({
      ...getAdminSession(),
      role: resolvedSession.role,
      permissions: resolvedSession.permissions,
      session_expire_at: resolvedSession.session_expire_at,
      last_login_at: resolvedSession.last_login_at
    })
  }

  next()
})

export default router
