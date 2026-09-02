<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">管理员账号</h2>
      <el-button
        v-if="canCreateAdminUser"
        type="primary"
        @click="openAdd"
      >
        添加管理员
      </el-button>
    </div>

    <p class="page-desc">先创建管理员账号并设置权限档位，再用绑定二维码关联微信。账号密码登录和微信扫码登录都会使用这里的账号配置。</p>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载管理员账号失败'"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <el-empty v-else-if="!loading && users.length === 0" description="暂无管理员账号" />

    <el-table v-else :data="users" border class="table-container" v-loading="loading">
      <el-table-column prop="username" label="管理员账号" width="160" />
      <el-table-column prop="name" label="姓名" width="150" />
      <el-table-column label="权限档位" width="130">
        <template #default="{ row }">
          <el-tag size="small">
            {{ getRoleLabel(row.role) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="微信绑定" width="130">
        <template #default="{ row }">
          <el-tag :type="row.openid ? 'success' : 'info'" size="small">
            {{ row.openid ? '已绑定' : '未绑定' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="openid" label="OpenID" min-width="240" show-overflow-tooltip />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="220" show-overflow-tooltip />
      <el-table-column label="添加时间" width="180">
        <template #default="{ row }">
          {{ formatTime(row.created_at) }}
        </template>
      </el-table-column>
      <el-table-column label="上次登录" width="180">
        <template #default="{ row }">
          {{ formatTime(row.last_login_at || row.updated_at) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="280" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="canUpdateAdminUser"
            type="primary"
            link
            @click="openEdit(row)"
          >
            编辑
          </el-button>
          <el-button
            v-if="canBindAdminUser"
            type="success"
            link
            @click="openBind(row)"
          >
            绑定微信
          </el-button>
          <el-button
            v-if="canToggleAdminUser"
            :type="row.status === 'active' ? 'warning' : 'success'"
            link
            @click="toggleStatus(row)"
          >
            {{ row.status === 'active' ? '停用' : '启用' }}
          </el-button>
          <el-button
            v-if="canDeleteAdminUser"
            type="danger"
            link
            @click="removeUser(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增 / 编辑 -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑管理员' : '添加管理员'" width="520px">
      <el-form :model="form" label-width="110px">
        <el-form-item label="管理员账号" prop="username" required>
          <el-input v-model="form.username" placeholder="请输入唯一账号" />
        </el-form-item>
        <el-form-item label="密码" :prop="isEdit ? undefined : 'password'" :required="!isEdit">
          <el-input v-model="form.password" type="password" show-password placeholder="新增时必填，编辑时选填" />
        </el-form-item>
        <el-form-item v-if="isEdit" class="form-item-inline">
          <el-text size="small" type="info">
            留空表示不修改密码
          </el-text>
        </el-form-item>
        <el-form-item label="权限档位" prop="role" required>
          <el-select v-model="form.role" placeholder="请选择权限档位" style="width: 100%;">
            <el-option
              v-for="item in ROLE_OPTIONS"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" placeholder="可选" />
        </el-form-item>
        <el-form-item label="OpenID" prop="openid">
          <el-input v-model="form.openid" placeholder="可手动填写，也可用绑定二维码自动绑定" />
        </el-form-item>
        <el-form-item label="备注" prop="remark">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ isEdit ? '保存' : '确定' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="bindDialogVisible" title="绑定微信" width="420px" @closed="handleBindDialogClosed">
      <div class="bind-dialog">
        <p class="bind-account">账号：{{ bindAccount.username }}</p>
        <div class="bind-qr-box">
          <img v-if="bindQrCodeUrl" :src="bindQrCodeUrl" class="bind-qr-image" alt="绑定微信二维码" />
          <div v-else class="bind-placeholder">{{ bindStatusText }}</div>
        </div>
        <p class="bind-tip">{{ bindStatusText }}</p>
      </div>
      <template #footer>
        <el-button @click="bindDialogVisible = false">关闭</el-button>
        <el-button type="primary" :loading="bindLoading" @click="createBindQr">
          刷新二维码
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, reactive, ref, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox, ElText } from 'element-plus'
import dayjs from 'dayjs'
import { adminUserApi } from '../api'
import { getAdminInfo, ROLE_OPTIONS, getRoleLabel, hasActionPermission } from '../utils/permissions'

const users = ref([])
const loading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')
const dialogVisible = ref(false)
const submitting = ref(false)
const isEdit = ref(false)
const editingId = ref('')
const bindDialogVisible = ref(false)
const bindLoading = ref(false)
const bindQrCodeUrl = ref('')
const bindStatusText = ref('正在生成二维码...')
const bindSessionId = ref('')
const bindExpiresAt = ref(0)
const bindAccount = reactive({ _id: '', username: '' })
let bindTimer = null
let bindExpireTimer = null

const canCreateAdminUser = computed(() => hasActionPermission('addAdminUser'))
const canUpdateAdminUser = computed(() => hasActionPermission('updateAdminUser'))
const canBindAdminUser = computed(() => hasActionPermission('createAdminBindSession'))
const canToggleAdminUser = computed(() => canUpdateAdminUser.value)
const canDeleteAdminUser = computed(() => hasActionPermission('removeAdminUser'))
const currentAdminId = computed(() => getAdminInfo().admin_id || '')
const roleSet = new Set(ROLE_OPTIONS.map(item => item.value))

const form = reactive({
  username: '',
  password: '',
  role: 'manager',
  name: '',
  openid: '',
  remark: ''
})

function resetForm() {
  form.username = ''
  form.password = ''
  form.role = 'manager'
  form.name = ''
  form.openid = ''
  form.remark = ''
}

function formatTime(time) {
  if (!time) return '-'
  const d = time.$date ? new Date(time.$date) : new Date(time)
  if (Number.isNaN(d.getTime())) {
    return '-'
  }
  return dayjs(d).format('YYYY-MM-DD HH:mm')
}

function getPermissionWarning(text) {
  ElMessage.warning(text)
}

async function loadData() {
  loading.value = true
  loadError.value = false
  errorMessage.value = ''
  try {
    users.value = await adminUserApi.getList()
  } catch (err) {
    ElMessage.error('加载失败：' + (err.message || '未知错误'))
    loadError.value = true
    errorMessage.value = err.message || '加载管理员账号失败'
    users.value = []
  } finally {
    loading.value = false
  }
}

function openAdd() {
  if (!canCreateAdminUser.value) {
    getPermissionWarning('暂无权限添加管理员')
    return
  }

  isEdit.value = false
  editingId.value = ''
  resetForm()
  dialogVisible.value = true
}

function openEdit(row) {
  if (!canUpdateAdminUser.value) {
    getPermissionWarning('暂无权限编辑管理员')
    return
  }

  isEdit.value = true
  editingId.value = row._id
  form.username = row.username || ''
  form.password = ''
  form.role = row.role || 'manager'
  form.name = row.name || ''
  form.openid = row.openid || ''
  form.remark = row.remark || ''
  dialogVisible.value = true
}

async function submitForm() {
  const username = form.username.trim()
  const role = form.role
  const password = (form.password || '').trim()

  if (!username) {
    ElMessage.warning('请输入管理员账号')
    return
  }

  if (!roleSet.has(role)) {
    ElMessage.warning('请选择正确的权限档位')
    return
  }

  if (!isEdit.value && !password) {
    ElMessage.warning('请输入密码')
    return
  }

  if (!isEdit.value && password.length < 6) {
    ElMessage.warning('密码长度不能少于 6 位')
    return
  }

  if (isEdit.value && !canUpdateAdminUser.value) {
    getPermissionWarning('暂无权限编辑管理员')
    return
  }
  if (!isEdit.value && !canCreateAdminUser.value) {
    getPermissionWarning('暂无权限添加管理员')
    return
  }

  submitting.value = true
  const action = isEdit.value ? '更新' : '添加'
  try {
    if (isEdit.value) {
      const payload = {
        username,
        role,
        name: form.name.trim(),
        openid: form.openid.trim(),
        remark: form.remark.trim()
      }
      if (password) {
        payload.password = password
      }
      await adminUserApi.update(editingId.value, payload)
      ElMessage.success('更新成功')
    } else {
      await adminUserApi.add({
        username,
        password,
        role,
        name: form.name.trim(),
        openid: form.openid.trim(),
        remark: form.remark.trim()
      })
      ElMessage.success('添加成功')
    }
    dialogVisible.value = false
    loadData()
  } catch (err) {
    ElMessage.error(`${action}失败：` + (err.message || '未知错误'))
  } finally {
    submitting.value = false
  }
}

async function openBind(row) {
  if (!canBindAdminUser.value) {
    getPermissionWarning('暂无权限绑定微信')
    return
  }

  bindAccount._id = row._id
  bindAccount.username = row.username || ''
  bindDialogVisible.value = true
  await createBindQr()
}

async function createBindQr() {
  if (!bindAccount._id || bindLoading.value) {
    return
  }

  bindLoading.value = true
  bindSessionId.value = ''
  stopBindPolling()
  stopBindExpireTimer()
  bindQrCodeUrl.value = ''
  bindStatusText.value = '正在生成二维码...'

  try {
    const session = await adminUserApi.createBindSession(bindAccount._id)
    bindSessionId.value = session.session_id
    bindExpiresAt.value = Number(session.expires_at || 0)
    if (!session.qr_code_base64) {
      throw new Error('云函数未返回小程序码，请检查微信 AppSecret 或云调用权限配置')
    }
    bindQrCodeUrl.value = `data:image/png;base64,${session.qr_code_base64}`
    bindStatusText.value = '请用需要绑定的微信扫码，进入小程序后将自动绑定'
    startBindPolling(session.session_id)
    startBindExpireTimer()
  } catch (err) {
    bindStatusText.value = err.message || '二维码生成失败'
    ElMessage.error('创建绑定二维码失败：' + bindStatusText.value)
  } finally {
    bindLoading.value = false
  }
}

function startBindPolling(sessionId) {
  bindTimer = window.setInterval(async () => {
    try {
      const status = await adminUserApi.checkBindSession(sessionId)
      if (status.status === 'confirmed') {
        bindStatusText.value = '绑定成功'
        stopBindPolling()
        stopBindExpireTimer()
        ElMessage.success('微信绑定成功')
        bindDialogVisible.value = false
        loadData()
      } else if (status.status === 'expired') {
        bindStatusText.value = '二维码已过期，请刷新'
        stopBindPolling()
        stopBindExpireTimer()
      } else if (status.status === 'rejected') {
        bindStatusText.value = status.reason || status.reject_reason || '绑定被拒绝'
        stopBindPolling()
        stopBindExpireTimer()
      }
    } catch (err) {
      bindStatusText.value = err.message || '绑定状态检查失败'
      stopBindPolling()
      stopBindExpireTimer()
    }
  }, 2000)
}

function stopBindPolling() {
  if (bindTimer) {
    window.clearInterval(bindTimer)
    bindTimer = null
  }
}

function startBindExpireTimer() {
  if (!bindExpiresAt.value) {
    return
  }

  bindExpireTimer = window.setTimeout(() => {
    bindStatusText.value = '二维码已过期，请刷新'
    stopBindPolling()
  }, Math.max(0, bindExpiresAt.value - Date.now()))
}

function stopBindExpireTimer() {
  if (bindExpireTimer) {
    window.clearTimeout(bindExpireTimer)
    bindExpireTimer = null
  }
}

function handleBindDialogClosed() {
  stopBindPolling()
  stopBindExpireTimer()
}

async function toggleStatus(row) {
  if (!canToggleAdminUser.value) {
    getPermissionWarning('暂无权限变更管理员状态')
    return
  }

  if (row._id === currentAdminId.value) {
    ElMessage.warning('不能对当前登录账号进行停用/启用操作')
    return
  }

  const nextStatus = row.status === 'active' ? 'inactive' : 'active'
  const action = nextStatus === 'active' ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(`确定要${action}管理员「${row.username}」吗？`, '确认操作', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await adminUserApi.updateStatus(row._id, nextStatus)
    ElMessage.success(nextStatus === 'active' ? '已启用' : '已停用')
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('状态更新失败：' + (err.message || '未知错误'))
    }
  }
}

async function removeUser(row) {
  if (!canDeleteAdminUser.value) {
    getPermissionWarning('暂无权限删除管理员')
    return
  }

  if (row._id === currentAdminId.value) {
    ElMessage.warning('不能删除当前登录账号')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除管理员「${row.username}」吗？`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
    await adminUserApi.remove(row._id)
    ElMessage.success('删除成功')
    loadData()
  } catch {
    // 取消
  }
}

onMounted(() => {
  loadData()
})

onUnmounted(() => {
  stopBindPolling()
  stopBindExpireTimer()
})
</script>

<style scoped>
.page-container {
  padding: 0;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-title {
  margin: 0;
  font-size: 20px;
}

.page-desc {
  color: #999;
  font-size: 13px;
  margin: 0 0 20px 0;
}

.table-container {
  width: 100%;
}

.form-item-inline {
  margin-top: -10px;
  margin-bottom: 18px;
}

.bind-dialog {
  text-align: center;
}

.bind-account {
  color: #606266;
  margin: 0 0 14px;
}

.bind-qr-box {
  width: 220px;
  height: 220px;
  margin: 0 auto 12px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fafafa;
}

.bind-qr-image {
  width: 200px;
  height: 200px;
  object-fit: contain;
}

.bind-placeholder {
  color: #909399;
  font-size: 13px;
}

.bind-tip {
  color: #606266;
  font-size: 13px;
  margin: 0;
}
</style>
