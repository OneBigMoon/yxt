<template>
  <div v-if="isBootstrapping" class="app-bootstrap">
    <div class="bootstrap-tip">系统安全初始化中...</div>
  </div>

  <template v-else>
    <!-- 登录页无布局 -->
    <router-view v-if="isLoginRoute" />

    <!-- 主布局 -->
    <el-container v-else-if="isAuthorizedMainReady" class="app-container">
      <el-aside width="200px" class="app-aside">
        <div class="logo">
          <h2>商务咨询预约</h2>
        </div>
        <el-menu
          :default-active="activeMenu"
          router
          class="sidebar-menu"
          background-color="#304156"
          text-color="#bfcbd9"
          active-text-color="#409eff"
        >
          <el-menu-item
            v-for="item in visibleMenus"
            :key="item.index"
            :index="item.index"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.title }}</span>
          </el-menu-item>
        </el-menu>
      </el-aside>
      <el-container>
        <el-header class="app-header">
          <div class="header-left">
            <el-button
              class="mobile-menu-button"
              link
              aria-label="打开导航菜单"
              @click="mobileMenuVisible = true"
            >
              <el-icon><Menu /></el-icon>
            </el-button>
            <el-breadcrumb separator="/">
              <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
              <el-breadcrumb-item v-if="currentRoute.meta.title">
                {{ currentRoute.meta.title }}
              </el-breadcrumb-item>
            </el-breadcrumb>
          </div>
          <div class="header-right">
            <el-dropdown>
              <span class="el-dropdown-link">
                <span class="admin-role">{{ roleLabel }}</span>
                <span>{{ adminDisplayName }}</span>
                <el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="handleLogout">退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </el-header>
        <el-main class="app-main">
          <router-view />
        </el-main>
      </el-container>
      <el-drawer
        v-model="mobileMenuVisible"
        class="mobile-drawer"
        direction="ltr"
        size="200px"
        title="主导航"
        :with-header="false"
      >
        <div class="logo">
          <h2>商务咨询预约</h2>
        </div>
        <el-menu
          :default-active="activeMenu"
          router
          class="sidebar-menu"
          background-color="#304156"
          text-color="#bfcbd9"
          active-text-color="#409eff"
          aria-label="主导航"
          @select="handleMobileMenuSelect"
        >
          <el-menu-item
            v-for="item in visibleMenus"
            :key="item.index"
            :index="item.index"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.title }}</span>
          </el-menu-item>
        </el-menu>
      </el-drawer>
    </el-container>

    <div v-else class="app-unauthorized">
      <p>当前会话无效，请重新登录后访问</p>
      <el-button type="primary" @click="redirectToLogin">重新登录</el-button>
    </div>
  </template>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authApi } from './api'
import {
  ArrowDown,
  Calendar,
  DataBoard,
  Document,
  Goods,
  Menu,
  Money,
  Setting,
  User,
  UserFilled
} from '@element-plus/icons-vue'
import {
  clearAdminInfo,
  getAdminInfo,
  getAdminRole,
  getRoleLabel,
  hasRoutePermission,
  getAdminSession,
  isSessionExpired,
  setAdminSession
} from './utils/permissions'

const STABLE_AUTH_ERROR_CODES = new Set([
  'TOKEN_EXPIRED',
  'SESSION_EXPIRED',
  'ROLE_MISMATCH',
  'INSUFFICIENT_PERMISSION',
  'USER_DISABLED'
])

const currentRoute = useRoute()
const router = useRouter()
const activeMenu = computed(() => currentRoute.path)
const isBootstrapping = ref(true)
const mobileMenuVisible = ref(false)
let desktopMediaQuery = null
const authStateTick = ref(0)
const menuItems = [
  { index: '/', title: '仪表盘', icon: DataBoard },
  { index: '/appointments', title: '预约管理', icon: Calendar },
  { index: '/customers', title: '客户管理', icon: User },
  { index: '/articles', title: '企业资讯', icon: Document },
  { index: '/services', title: '服务管理', icon: Goods },
  { index: '/technicians', title: '顾问管理', icon: UserFilled },
  { index: '/rest-management', title: '休息管理', icon: Calendar },
  { index: '/business-config', title: '营业设置', icon: Setting },
  { index: '/commissions', title: '提成统计', icon: Money },
  { index: '/admin-users', title: '管理员账号', icon: User },
  { index: '/audit-logs', title: '操作审计', icon: Setting }
  ]

const normalizedRoutePath = computed(() => {
  const path = (currentRoute.path || '').replace(/\/+$/g, '')
  return path || '/'
})

const currentRole = computed(() => {
  authStateTick.value
  return getAdminRole()
})
const roleLabel = computed(() => getRoleLabel(currentRole.value))
const adminInfo = computed(() => {
  authStateTick.value
  return getAdminInfo()
})
const adminDisplayName = computed(() => adminInfo.value.username || '管理员')
const isLoginRoute = computed(() => normalizedRoutePath.value === '/login')
const hasUsableSession = computed(() => {
  authStateTick.value
  const session = getAdminSession()
  return Boolean(session && session.token && session.role && !isSessionExpired(session))
})
const canEnterCurrentRoute = computed(() => {
  authStateTick.value
  return hasRoutePermission(normalizedRoutePath.value, currentRole.value)
})
const isAuthorizedMainReady = computed(() => {
  return hasUsableSession.value && canEnterCurrentRoute.value
})
const visibleMenus = computed(() => {
  authStateTick.value
  return menuItems.filter(item => hasRoutePermission(item.index, currentRole.value))
})

function refreshLocalSessionState() {
  authStateTick.value += 1
}

function setBootstrapState({ loading, routeRefresh = false } = {}) {
  isBootstrapping.value = loading
  if (routeRefresh) {
    authStateTick.value += 1
  }
}

async function redirectToLogin() {
  if (!isLoginRoute.value) {
    try {
      await router.replace('/login')
    } catch {
      // ignore navigation failure
    }
  }
}

async function handleAuthInvalid() {
  clearAdminInfo()
  refreshLocalSessionState()
  setBootstrapState({ loading: false, routeRefresh: true })
  if (!isLoginRoute.value) {
    await redirectToLogin()
    ElMessage.warning('登录状态已失效，请重新登录')
  }
}

function handleSessionUpdated() {
  refreshLocalSessionState()
  if (isLoginRoute.value) {
    router.replace('/')
  }
}

function handleDesktopBreakpoint(event) {
  if (event.matches) {
    closeMobileMenu()
  }
}

async function bootstrapAuthState() {
  setBootstrapState({ loading: true })
  const localSession = getAdminSession()
  if (!localSession || !localSession.token || !localSession.role || isSessionExpired(localSession)) {
    clearAdminInfo()
    await redirectToLogin()
    setBootstrapState({ loading: false })
    return
  }

  try {
    const remote = await authApi.getCurrent()
    if (remote && remote.username && remote.role) {
      setAdminSession({
        ...localSession,
        ...remote
      })
      refreshLocalSessionState()
    } else {
      clearAdminInfo()
      if (!isLoginRoute.value) {
        await redirectToLogin()
      }
    }
  } catch (err) {
    const code = err && err.error_code ? String(err.error_code) : ''
    if (!code || !STABLE_AUTH_ERROR_CODES.has(code)) {
      console.warn('初始化会话失败（网络/服务波动），保留本地会话状态：', err)
      if (!isLoginRoute.value) {
        refreshLocalSessionState()
      }
    } else {
      clearAdminInfo()
      if (!isLoginRoute.value) {
        await redirectToLogin()
      }
    }
    refreshLocalSessionState()
    console.error('初始化会话失败:', err)
  } finally {
    setBootstrapState({ loading: false })
  }
}

onMounted(() => {
  window.addEventListener('admin:auth-invalid', handleAuthInvalid)
  window.addEventListener('admin:session-updated', handleSessionUpdated)
  desktopMediaQuery = window.matchMedia('(min-width: 769px)')
  desktopMediaQuery.addEventListener('change', handleDesktopBreakpoint)
  handleDesktopBreakpoint(desktopMediaQuery)
  bootstrapAuthState()
})

onUnmounted(() => {
  window.removeEventListener('admin:auth-invalid', handleAuthInvalid)
  window.removeEventListener('admin:session-updated', handleSessionUpdated)
  desktopMediaQuery?.removeEventListener('change', handleDesktopBreakpoint)
})

async function handleLogout() {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })

    await authApi.logout()
    clearAdminInfo()
    router.push('/login')
    ElMessage.success('已退出登录')
  } catch {
    // 取消
  }
}

function closeMobileMenu() {
  mobileMenuVisible.value = false
}

function handleMobileMenuSelect(_index, _indexPath, _item, routeResult) {
  if (routeResult && typeof routeResult.then === 'function') {
    routeResult.then(closeMobileMenu, closeMobileMenu)
    return
  }
  closeMobileMenu()
}
</script>

<style scoped>
.app-bootstrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f0f2f5;
}

.bootstrap-tip {
  color: #606266;
  font-size: 14px;
}

.app-container {
  height: 100vh;
}

.app-container > .el-container {
  min-width: 0;
}

.app-aside {
  background-color: #304156;
  overflow: hidden;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.logo h2 {
  font-size: 18px;
  margin: 0;
}

.sidebar-menu {
  border-right: none;
}

.app-header {
  background-color: #fff;
  border-bottom: 1px solid #e6e6e6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.mobile-menu-button {
  display: none;
}

.header-left {
  display: flex;
  align-items: center;
}

.header-right {
  display: flex;
  align-items: center;
}

.el-dropdown-link {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

.admin-role {
  color: #909399;
  font-size: 12px;
}

.app-main {
  background-color: #f5f5f5;
  padding: 20px;
  min-width: 0;
}

:global(.mobile-drawer .el-drawer__body) {
  padding: 0;
  background-color: #304156;
}

.app-unauthorized {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #909399;
  background: #f0f2f5;
}

@media (max-width: 768px) {
  .app-aside {
    display: none;
  }

  .app-header {
    padding: 0 12px;
    gap: 8px;
  }

  .header-left {
    min-width: 0;
    gap: 8px;
  }

  .header-left .el-breadcrumb {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .header-right {
    flex-shrink: 0;
  }

  .mobile-menu-button {
    display: inline-flex;
    flex-shrink: 0;
    margin: 0;
  }

  .app-main {
    padding: 12px;
  }
}
</style>
