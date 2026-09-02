<template>
  <div class="login-container">
    <div class="login-card">
      <h2 class="login-title">壹心堂中医门诊</h2>
      <p class="login-subtitle">管理后台</p>

      <el-tabs v-model="activeMethod" stretch class="login-tabs">
        <el-tab-pane label="账号密码登录" name="password">
          <el-form :model="form" ref="formRef">
            <el-form-item>
              <el-input
                v-model="form.username"
                placeholder="请输入管理员账号"
                size="large"
                @keyup.enter="handlePasswordLogin"
                @input="onInputChanged"
              />
            </el-form-item>
            <el-form-item>
              <el-input
                v-model="form.password"
                type="password"
                placeholder="请输入密码"
                show-password
                size="large"
                @keyup.enter="handlePasswordLogin"
              />
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                size="large"
                style="width: 100%;"
                :loading="loading"
                @click="handlePasswordLogin"
              >
                登录
              </el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="扫码登录" name="scan">
          <div class="scan-login">
            <div class="qr-box">
              <img v-if="qrCodeUrl" :src="qrCodeUrl" class="qr-image" alt="扫码登录二维码" />
              <div v-else class="qr-placeholder">
                {{ scanStatusText }}
              </div>
            </div>
            <p class="scan-tip">{{ scanStatusText }}</p>
            <el-button
              size="small"
              :loading="scanLoading"
              @click="startScanLogin"
            >
              {{ sessionId ? '刷新二维码' : '生成二维码' }}
            </el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { authApi, scanLoginApi } from '../api'
import { isKnownRole, setAdminSession } from '../utils/permissions'

const router = useRouter()
const activeMethod = ref('password')
const loading = ref(false)
const scanLoading = ref(false)
const form = ref({ username: '', password: '' })
const qrCodeUrl = ref('')
const sessionId = ref('')
const formRef = ref(null)
const scanStatusText = ref('点击生成二维码')
const scanExpiresAt = ref(0)
const VALID_SCAN_STATUSES = new Set(['pending', 'confirmed', 'logged_in', 'expired', 'rejected'])
let scanTimer = null
let scanExpireTimer = null
let mounted = false
let scanRequestToken = 0

async function handlePasswordLogin() {
  if (loading.value) {
    return
  }

  const username = (form.value.username || '').trim()
  const password = form.value.password

  if (!username || !password) {
    ElMessage.warning('请输入管理员账号和密码')
    return
  }

  if (username.length > 64) {
    ElMessage.warning('账号长度不能超过 64 个字符')
    return
  }

  if (password.length < 6) {
    ElMessage.warning('密码长度不能少于 6 位')
    return
  }

  loading.value = true
  try {
    const result = await authApi.passwordLogin({ username, password })
    await doLogin(result, username)
  } catch (err) {
    ElMessage.error(err.message || '账号或密码错误')
  } finally {
    loading.value = false
  }
}

function emitSessionUpdated() {
  window.dispatchEvent(new CustomEvent('admin:session-updated'))
}

async function doLogin(result, fallbackUsername = '') {
  const token = typeof result === 'string' ? result : result && result.token
  if (!token) {
    ElMessage.error('登录失败：云函数未返回会话 token')
    return
  }

  const role = isKnownRole(result && result.role ? result.role : '') ? result.role : ''
  if (!role) {
    ElMessage.error('登录失败：管理员角色未授权或配置异常')
    return
  }

  const permissions = Array.isArray(result.permissions) ? result.permissions : []
  const sessionExpireAt = Number(result.session_expire_at || result.expires_at || 0)
  if (!sessionExpireAt) {
    ElMessage.warning('登录成功，但会话有效期异常，建议重新登录')
  }

  const adminId = result.admin_id || result.admin_user_id
  if (!adminId) {
    ElMessage.warning('登录成功，但管理员账号标识缺失，请联系管理员处理')
  }

  setAdminSession({
    token,
    username: result.username || fallbackUsername || '管理员',
    role,
    permissions,
    session_expire_at: sessionExpireAt,
    last_login_at: result.last_login_at || Date.now(),
    admin_id: adminId,
    tenant_scope: result.tenant_scope || 'single_store'
  })

  emitSessionUpdated()

  stopPolling()
  stopExpireTimer()
  ElMessage.success('登录成功')
  await router.push('/')
}

function normalizeScanRole(rawRole) {
  const role = String(rawRole || '').trim()
  return isKnownRole(role) ? role : ''
}

function getFriendlyScanError(err) {
  const message = err && err.message ? err.message : ''
  if (message.includes('network request error') || message.includes('Network Error')) {
    return '云函数网络请求失败，请确认匿名登录、域名白名单和 admin 云函数已部署'
  }
  return message || '二维码操作失败'
}

function isTransientScanError(message = '') {
  const normalized = String(message)
  return normalized.includes('Network') ||
    normalized.includes('网络') ||
    normalized.includes('network') ||
    normalized.includes('timeout') ||
    normalized.includes('超时')
}

function onInputChanged() {
  if (typeof form.value.username === 'string') {
    form.value.username = form.value.username.trimStart()
  }
}

async function startScanLogin() {
  if (scanLoading.value) {
    return
  }

  scanLoading.value = true
  stopPolling()
  stopExpireTimer()
  const requestToken = ++scanRequestToken

  try {
    const session = await scanLoginApi.createSession()
    if (activeMethod.value !== 'scan' || requestToken !== scanRequestToken || !mounted) {
      return
    }
    if (!session || !session.session_id) {
      throw new Error('云函数未返回扫码会话')
    }

    sessionId.value = session.session_id
    scanExpiresAt.value = Number(session.expires_at || 0)

    if (!session.qr_code_base64) {
      throw new Error('云函数未返回小程序码，请检查微信 AppSecret 或云调用权限配置')
    }

    qrCodeUrl.value = `data:image/png;base64,${session.qr_code_base64}`
    scanStatusText.value = '请用微信扫码，进入小程序后将自动确认'
    startPolling(session.session_id, requestToken)
    startExpireTimer()
  } catch (err) {
    if (requestToken !== scanRequestToken || !mounted) {
      return
    }
    qrCodeUrl.value = ''
    sessionId.value = ''
    scanExpiresAt.value = 0
    scanStatusText.value = getFriendlyScanError(err)
    ElMessage.error(`创建扫码登录失败：${scanStatusText.value}`)
  } finally {
    scanLoading.value = false
  }
}

function startPolling(id, requestToken) {
  if (scanTimer) {
    window.clearInterval(scanTimer)
    scanTimer = null
  }

  scanTimer = window.setInterval(async () => {
    if (!mounted || requestToken !== scanRequestToken || activeMethod.value !== 'scan') {
      stopPolling()
      return
    }

    try {
      const status = await scanLoginApi.checkSession(id)
      const currentStatus = String(status && status.status || '').toLowerCase()

      if (!VALID_SCAN_STATUSES.has(currentStatus)) {
        return
      }

      if (currentStatus === 'confirmed') {
        scanStatusText.value = '已确认，正在登录...'
        const result = await scanLoginApi.scanLogin(id)
        await doLogin(result)
        return
      }

      if (currentStatus === 'logged_in') {
        scanStatusText.value = '会话已登录，正在进入管理台...'
        await doLogin({
          ...status,
          token: status.token || '',
          role: normalizeScanRole(status.role || status.admin_role || '')
        })
        return
      }

      if (currentStatus === 'expired') {
        scanStatusText.value = '二维码已过期，请刷新'
        stopPolling()
      } else if (currentStatus === 'rejected') {
        scanStatusText.value = status.reason || status.reject_reason || '扫码登录被拒绝'
        stopPolling()
      } else {
        if (status.status_text) {
          scanStatusText.value = status.status_text
        } else if (status.message) {
          scanStatusText.value = status.message
        }
      }
    } catch (err) {
      scanStatusText.value = getFriendlyScanError(err)
      if (!isTransientScanError(scanStatusText.value)) {
        stopPolling()
      }
    }
  }, 2000)
}

function stopPolling() {
  if (scanTimer) {
    window.clearInterval(scanTimer)
    scanTimer = null
  }
  scanRequestToken += 1
}

function startExpireTimer() {
  if (!scanExpiresAt.value) {
    return
  }

  scanExpireTimer = window.setTimeout(() => {
    scanStatusText.value = '二维码已过期，请刷新'
    stopPolling()
  }, Math.max(0, scanExpiresAt.value - Date.now()))
}

function stopExpireTimer() {
  if (scanExpireTimer) {
    window.clearTimeout(scanExpireTimer)
    scanExpireTimer = null
  }
}

watch(activeMethod, (method) => {
  if (method === 'scan') {
    if (!sessionId.value || scanStatusText.value.includes('过期') || scanStatusText.value.includes('失败')) {
      startScanLogin()
    }
  } else {
    stopPolling()
  }
})

onUnmounted(() => {
  mounted = false
  stopPolling()
  stopExpireTimer()
})

onMounted(() => {
  mounted = true
  if (activeMethod.value === 'scan') {
    startScanLogin()
  }
})

</script>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #eef2f0;
}

.login-card {
  background: #fff;
  border-radius: 8px;
  padding: 36px;
  width: 420px;
  box-shadow: 0 18px 50px rgba(35, 45, 40, 0.12);
}

.login-title {
  text-align: center;
  font-size: 24px;
  color: #333;
  margin-bottom: 8px;
}

.login-subtitle {
  text-align: center;
  font-size: 14px;
  color: #999;
  margin-bottom: 20px;
}

.login-tabs {
  min-height: 330px;
}

.scan-login {
  text-align: center;
  padding-top: 18px;
}

.qr-box {
  width: 180px;
  height: 180px;
  margin: 0 auto 10px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fafafa;
  overflow: hidden;
}

.qr-image {
  width: 160px;
  height: 160px;
  object-fit: contain;
}

.qr-placeholder {
  color: #999;
  font-size: 13px;
}

.scan-tip {
  color: #666;
  font-size: 13px;
  margin: 0 0 12px;
}
</style>
