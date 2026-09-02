<template>
  <div class="dashboard">
    <!-- 今日营业状态 -->
    <el-card shadow="hover" class="status-card" v-loading="loading">
      <div class="status-header">
        <div class="status-info">
          <el-icon :size="20" :color="isClosed ? '#F56C6C' : '#67C23A'">
            <component :is="isClosed ? 'CircleClose' : 'CircleCheck'" />
          </el-icon>
          <span class="status-text">今日营业状态：</span>
          <el-tag :type="isClosed ? 'danger' : 'success'" size="large">
            {{ isClosed ? '已停业' : '营业中' }}
          </el-tag>
          <span v-if="closureReason" class="closure-reason">（{{ closureReason }}）</span>
        </div>
          <el-button
            v-if="canSetClosure"
            type="primary"
            @click="showClosureDialog"
          >
            设置停业
          </el-button>
      </div>
    </el-card>

    <div v-if="!loadError" class="dashboard-metrics">
      <el-card class="metric-card metric-total" shadow="never">
        <span>今日预约</span>
        <strong>{{ todayOverview.total }}</strong>
      </el-card>
      <el-card class="metric-card metric-pending" shadow="never">
        <span>待到店/待核销</span>
        <strong>{{ todayOverview.pending }}</strong>
      </el-card>
      <el-card class="metric-card metric-completed" shadow="never">
        <span>已完成</span>
        <strong>{{ todayOverview.completed }}</strong>
      </el-card>
    </div>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载仪表盘失败'"
      style="margin-top: 20px;"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <!-- 今日预约列表 -->
    <el-card v-else shadow="hover" style="margin-top: 20px;" v-loading="loading">
      <template #header>
        <div class="card-header">
          <span>今日预约列表</span>
          <el-tag type="info" size="small">共 {{ todayAppointments.length }} 条</el-tag>
        </div>
      </template>
      <el-table :data="todayAppointments" border stripe>
        <el-table-column prop="start_time" label="时间" width="100">
          <template #default="{ row }">
            {{ row.start_time }}-{{ row.end_time }}
          </template>
        </el-table-column>
        <el-table-column prop="service_names" label="服务项目" min-width="150" />
        <el-table-column prop="patient_name" label="客户" width="120" />
        <el-table-column prop="technician_name" label="技师" width="120">
          <template #default="{ row }">
            {{ row.technician_name || '待分配' }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'pending' ? 'warning' : row.status === 'completed' ? 'success' : 'info'" size="small">
              {{ row.status === 'pending' ? '待核销' : row.status === 'completed' ? '已核销' : '已取消' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="todayAppointments.length === 0" description="今日暂无预约" />
    </el-card>

    <!-- 设置停业弹窗 -->
    <el-dialog v-model="closureDialogVisible" title="设置停业" width="500px">
      <el-form :model="closureForm" label-width="80px">
        <el-form-item label="停业日期" required>
          <el-date-picker
            v-model="closureForm.dates"
            type="dates"
            placeholder="选择一个或多个日期"
            value-format="YYYY-MM-DD"
            style="width: 100%;"
          />
        </el-form-item>
        <el-form-item label="停业原因">
          <el-input v-model="closureForm.reason" placeholder="如：节假日休息、设备维护" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="closureDialogVisible = false">取消</el-button>
          <el-button
            type="primary"
            :loading="saveClosureLoading"
            @click="saveClosure"
          >
            确定停业
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { appointmentApi, restApi } from '../api'
import { hasActionPermission } from '../utils/permissions'

const todayAppointments = ref([])

const todayOverview = computed(() => {
  const list = todayAppointments.value || []
  return {
    total: list.length,
    pending: list.filter(item => item.status === 'pending' || item.status === 'confirmed').length,
    completed: list.filter(item => item.status === 'completed').length
  }
})
const todayHoliday = ref(null)
const closureDialogVisible = ref(false)
const closureForm = ref({ dates: [], reason: '' })
const loading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')
const saveClosureLoading = ref(false)
const canSetClosure = computed(() => hasActionPermission('addHoliday'))

const isClosed = computed(() => !!todayHoliday.value)
const closureReason = computed(() => todayHoliday.value?.reason || '')

onMounted(() => {
  loadData()
})

async function loadData() {
  loading.value = true
  loadError.value = false
  errorMessage.value = ''
  try {
    await Promise.all([loadTodayAppointments(), loadTodayStatus()])
  } finally {
    loading.value = false
  }
}

async function loadTodayAppointments() {
  try {
    const today = formatDate(new Date())
    const result = await appointmentApi.getList({ date: today })
    todayAppointments.value = result.list || result || []
  } catch (err) {
    console.error('加载预约数据失败:', err)
    loadError.value = true
    errorMessage.value = err.message || '加载预约数据失败'
    todayAppointments.value = []
    ElMessage.error('加载预约数据失败')
  }
}

async function loadTodayStatus() {
  try {
    const today = formatDate(new Date())
    const holidays = await restApi.getHolidays({ type: 'closure' })
    todayHoliday.value = (holidays || []).find(h => h.date === today) || null
  } catch (err) {
    console.error('加载营业状态失败:', err)
    loadError.value = true
    errorMessage.value = err.message || '加载营业状态失败'
    ElMessage.error('加载营业状态失败')
  }
}

function showClosureDialog() {
  closureForm.value = { dates: [], reason: '' }
  closureDialogVisible.value = true
}

async function saveClosure() {
  const { dates, reason } = closureForm.value

  if (!canSetClosure.value) {
    ElMessage.warning('暂无权限执行停业设置')
    return
  }

  if (!dates || dates.length === 0) {
    ElMessage.warning('请选择停业日期')
    return
  }

  const uniqueDates = Array.from(new Set(dates)).sort()
  const invalidDate = uniqueDates.find(item => !/^\d{4}-\d{2}-\d{2}$/.test(item || ''))
  if (invalidDate) {
    ElMessage.warning(`停业日期格式异常：${invalidDate}`)
    return
  }

  try {
    await ElMessageBox.confirm('确定要新增这些停业日吗？', '确认操作', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch (err) {
    if (err === 'cancel') {
      return
    }
    return
  }

  let successCount = 0
  let skipCount = 0

  saveClosureLoading.value = true
  try {
    for (const date of uniqueDates) {
      try {
        await restApi.addHoliday({ date, type: 'closure', reason: reason || '' })
        successCount++
      } catch (err) {
        if (err.message && err.message.includes('已存在')) {
          skipCount++
        } else {
          console.error(`设置 ${date} 停业失败:`, err)
        }
      }
    }
  } finally {
    saveClosureLoading.value = false
  }
  closureDialogVisible.value = false

  let msg = `成功设置 ${successCount} 天停业`
  if (skipCount > 0) msg += `，${skipCount} 天已有记录跳过`
  ElMessage.success(msg)

  loadTodayStatus()
}

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
</script>

<style scoped>
.dashboard {
  padding: 0;
}

.status-card {
  background: linear-gradient(135deg, #f5f7fa 0%, #fff 100%);
}

.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.status-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-text {
  font-size: 16px;
  color: #333;
}

.closure-reason {
  font-size: 14px;
  color: #909399;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* P0 dashboard polish */
.status-card {
  border: 0;
  border-radius: 18px;
  background:
    radial-gradient(circle at 92% 8%, rgba(192, 96, 69, 0.16), transparent 28%),
    linear-gradient(135deg, #fffaf2 0%, #f4eadb 100%);
  box-shadow: 0 18px 44px rgba(93, 71, 45, 0.09);
}

.dashboard-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin: 16px 0;
}

.metric-card {
  border-radius: 16px;
  border: 1px solid rgba(100, 70, 40, 0.08);
}

.metric-card :deep(.el-card__body) {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  min-height: 82px;
}

.metric-card span {
  color: #7a7165;
  font-size: 14px;
}

.metric-card strong {
  color: #231f1a;
  font-size: 34px;
  line-height: 1;
}

.metric-pending strong {
  color: #c06045;
}

.metric-completed strong {
  color: #5a7846;
}

@media (max-width: 900px) {
  .dashboard-metrics {
    grid-template-columns: 1fr;
  }
}
</style>