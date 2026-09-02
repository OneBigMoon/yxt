<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">技师管理</h2>
      <el-button
        v-if="canCreateTechnician"
        type="primary"
        @click="showAddDialog"
      >
        添加技师
      </el-button>
    </div>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载技师列表失败'"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <el-empty v-else-if="!loading && technicians.length === 0" description="暂无技师" />

    <el-table v-else :data="technicians" border class="table-container" v-loading="loading">
      <el-table-column prop="name" label="姓名" width="120" />
      <el-table-column prop="phone" label="手机号" width="150" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '启用' : '禁用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="180">
        <template #default="{ row }">
          {{ formatTime(row.created_at || row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="360" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="canUpdateTechnician"
            type="primary"
            link
            @click="editTechnician(row)"
          >
            编辑
          </el-button>
          <el-button
            v-if="canUpdateTechnician"
            type="primary"
            link
            @click="editCommission(row)"
          >
            设置提成
          </el-button>
          <el-button
            v-if="canToggleTechnician"
            :type="row.status === 'active' ? 'warning' : 'success'"
            link
            @click="toggleStatus(row)"
          >
            {{ row.status === 'active' ? '禁用' : '启用' }}
          </el-button>
          <el-button
            v-if="canDeleteTechnician"
            type="danger"
            link
            @click="deleteTechnician(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 添加/编辑弹窗 -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑技师' : '添加技师'" width="500px">
      <el-form :model="formData" label-width="100px">
        <el-form-item label="姓名" required>
          <el-input v-model="formData.name" placeholder="请输入技师姓名" />
        </el-form-item>
        <el-form-item label="手机号" required>
          <el-input v-model="formData.phone" placeholder="请输入手机号" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitLoading" @click="saveTechnician">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 提成设置弹窗 -->
    <el-dialog v-model="commissionVisible" title="设置个人提成" width="600px">
      <el-alert
        title="设置技师个人提成将覆盖服务项目的默认提成"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 20px;"
      />
      <el-table :data="services" border>
        <el-table-column prop="name" label="服务项目" />
        <el-table-column prop="default_commission" label="默认提成(元)" width="120">
          <template #default="{ row }">
            {{ ((row.default_commission || 0) / 100).toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column label="个人提成(元)" width="150">
          <template #default="{ row }">
            <el-input-number
              v-model="commissionData[row._id]"
              :min="0"
              :precision="2"
              :step="10"
              size="small"
            />
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="commissionVisible = false">取消</el-button>
          <el-button type="primary" @click="saveCommission">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { technicianApi, serviceApi } from '../api'
import { hasActionPermission } from '../utils/permissions'

const technicians = ref([])
const services = ref([])
const dialogVisible = ref(false)
const commissionVisible = ref(false)
const isEdit = ref(false)
const currentId = ref('')
const loading = ref(false)
const submitLoading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')

const canCreateTechnician = computed(() => hasActionPermission('createTechnician'))
const canUpdateTechnician = computed(() => hasActionPermission('updateTechnician'))
const canToggleTechnician = computed(() => hasActionPermission('toggleTechnicianStatus'))
const canDeleteTechnician = computed(() => hasActionPermission('deleteTechnician'))

const formData = ref({
  name: '',
  phone: ''
})

const commissionData = ref({})

onMounted(() => {
  loadData()
  loadServices()
})

async function loadData() {
  loading.value = true
  loadError.value = false
  errorMessage.value = ''
  try {
    technicians.value = await technicianApi.getList()
  } catch (err) {
    console.error('加载技师数据失败:', err)
    ElMessage.error('加载技师数据失败')
    loadError.value = true
    errorMessage.value = err.message || '加载技师列表失败'
    technicians.value = []
  } finally {
    loading.value = false
  }
}

async function loadServices() {
  try {
    services.value = await serviceApi.getList()
  } catch (err) {
    console.error('加载服务数据失败:', err)
    ElMessage.error('加载服务数据失败')
    // ignore
  }
}

function showAddDialog() {
  isEdit.value = false
  formData.value = { name: '', phone: '' }
  dialogVisible.value = true
}

function editTechnician(row) {
  isEdit.value = true
  currentId.value = row._id
  formData.value = {
    name: row.name,
    phone: row.phone
  }
  dialogVisible.value = true
}

async function saveTechnician() {
  const phone = (formData.value.phone || '').trim()
  if (!formData.value.name || !phone) {
    ElMessage.warning('请填写完整信息')
    return
  }
  if (!/^1\d{10}$/.test(phone)) {
    ElMessage.warning('请输入有效的手机号')
    return
  }

  submitLoading.value = true
  try {
    const payload = {
      name: formData.value.name.trim(),
      phone
    }
    if (isEdit.value) {
      await technicianApi.update(currentId.value, payload)
      ElMessage.success('更新成功')
    } else {
      await technicianApi.create(payload)
      ElMessage.success('添加成功')
    }
    dialogVisible.value = false
    loadData()
  } catch (err) {
    ElMessage.error('操作失败')
  } finally {
    submitLoading.value = false
  }
}

async function toggleStatus(row) {
  const newStatus = row.status === 'active' ? 'inactive' : 'active'
  const action = newStatus === 'active' ? '启用' : '禁用'

  try {
    await ElMessageBox.confirm(`确定要${action}该技师吗？`, '确认操作', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await technicianApi.toggleStatus(row._id, newStatus)
    ElMessage.success(`${action}成功`)
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败')
    }
  }
}

async function deleteTechnician(row) {
  if (!canDeleteTechnician.value) {
    ElMessage.warning('暂无权限删除技师')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除技师「${row.name || row.phone || ''}」吗？历史预约和提成记录会保留。`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    await technicianApi.delete(row._id)
    ElMessage.success('删除成功')
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

function editCommission(row) {
  currentId.value = row._id

  // 初始化提成数据
  const data = {}
  services.value.forEach(service => {
    const custom = row.custom_commissions && row.custom_commissions[service._id]
    data[service._id] = custom != null ? custom / 100 : (service.default_commission || 0) / 100
  })
  commissionData.value = data

  commissionVisible.value = true
}

async function saveCommission() {
  // 验证提成不超过服务价格
  for (const key of Object.keys(commissionData.value)) {
    const commission = commissionData.value[key] || 0
    const service = services.value.find(s => s._id === key)
    const price = service ? (service.price || 0) / 100 : 0
    if (commission > price) {
      ElMessage.warning(`「${service ? service.name : key}」的提成不能大于服务价格（¥${price.toFixed(2)}）`)
      return
    }
  }

  try {
    const custom_commissions = {}
    Object.keys(commissionData.value).forEach(key => {
      custom_commissions[key] = Math.round((commissionData.value[key] || 0) * 100)
    })

    await technicianApi.update(currentId.value, { custom_commissions })
    ElMessage.success('提成设置成功')
    commissionVisible.value = false
    loadData()
  } catch (err) {
    ElMessage.error('保存失败')
  }
}

function formatTime(val) {
  if (!val) return '-'
  const d = new Date(val)
  if (isNaN(d.getTime())) return val
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<style scoped>
.page-container {
  background-color: #fff;
  border-radius: 4px;
  padding: 20px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}
</style>
