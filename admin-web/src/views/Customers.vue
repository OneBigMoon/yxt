<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">客户管理</h2>
    </div>

    <div class="filter-container">
      <div class="filter-item">
        <span class="filter-label">搜索：</span>
        <el-input v-model="filters.keyword" placeholder="昵称/手机号" clearable @clear="loadData" @keyup.enter="loadData" />
      </div>
      <el-button type="primary" @click="loadData">查询</el-button>
    </div>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载客户列表失败'"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <el-empty v-else-if="!loading && customers.length === 0" description="暂无客户" />

    <el-table v-else :data="customers" border class="table-container" v-loading="loading">
      <el-table-column label="头像" width="80">
        <template #default="{ row }">
          <el-avatar :size="40" :src="(row.avatar_url || row.avatarUrl) || undefined">
            <img src="/logo.jpg" />
          </el-avatar>
        </template>
      </el-table-column>
      <el-table-column label="昵称" width="150">
        <template #default="{ row }">
          {{ row.nick_name || row.nickname || '未设置' }}
        </template>
      </el-table-column>
      <el-table-column prop="phone" label="手机号" width="150" />
      <el-table-column label="注册时间" width="180">
        <template #default="{ row }">
          {{ formatTime(row.created_at || row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column label="黑名单" width="100">
        <template #default="{ row }">
          <el-tag :type="row.is_blacklisted ? 'danger' : 'success'" size="small">
            {{ row.is_blacklisted ? '是' : '否' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="notes" label="备注" min-width="200" show-overflow-tooltip />
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link @click="viewAppointments(row)">预约记录</el-button>
          <el-button
            v-if="canUpdateCustomer"
            type="primary"
            link
            @click="editNotes(row)"
          >
            备注
          </el-button>
          <el-button
            v-if="canToggleBlacklist"
            :type="row.is_blacklisted ? 'success' : 'danger'"
            link
            @click="toggleBlacklist(row)"
          >
            {{ row.is_blacklisted ? '取消黑名单' : '加入黑名单' }}
          </el-button>
          <el-button
            v-if="canDeleteCustomer"
            type="danger"
            link
            @click="deleteCustomer(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination-container">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="loadData"
        @current-change="loadData"
      />
    </div>

    <!-- 备注弹窗 -->
    <el-dialog v-model="notesVisible" title="编辑备注" width="500px">
      <el-input
        v-model="currentNotes"
        type="textarea"
        :rows="4"
        placeholder="请输入备注信息（如过敏史、注意事项等）"
      />
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="notesVisible = false">取消</el-button>
          <el-button type="primary" @click="saveNotes">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 预约记录弹窗 -->
    <el-dialog v-model="appointmentsVisible" title="预约记录" width="800px">
      <el-empty v-if="customerAppointments.length === 0 && !appointmentsLoading" description="暂无预约记录" />
      <el-table v-else :data="customerAppointments" border v-loading="appointmentsLoading">
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column prop="start_time" label="时间" width="100" />
        <el-table-column prop="service_names" label="服务项目" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)" size="small">
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { customerApi, appointmentApi } from '../api'
import { hasActionPermission } from '../utils/permissions'

const customers = ref([])
const filters = ref({ keyword: '' })
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)
const loading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')

const canUpdateCustomer = computed(() => hasActionPermission('updateCustomer'))
const canDeleteCustomer = computed(() => hasActionPermission('deleteCustomer'))
const canToggleBlacklist = computed(() => hasActionPermission('toggleBlacklist'))

const notesVisible = ref(false)
const currentCustomerId = ref('')
const currentNotes = ref('')

const appointmentsVisible = ref(false)
const customerAppointments = ref([])
const appointmentsLoading = ref(false)

onMounted(() => {
  loadData()
})

async function loadData() {
  loading.value = true
  loadError.value = false
  errorMessage.value = ''
  try {
    const params = {
      page: currentPage.value,
      page_size: pageSize.value,
      ...filters.value
    }
    const data = await customerApi.getList(params)
    customers.value = data.list || data
    total.value = data.total || customers.value.length
  } catch (err) {
    console.error('加载客户数据失败:', err)
    ElMessage.error('加载客户数据失败：' + (err.message || '请检查云开发匿名登录是否已开启'))
    loadError.value = true
    errorMessage.value = err.message || '加载客户列表失败'
    customers.value = []
  } finally {
    loading.value = false
  }
}

function editNotes(row) {
  currentCustomerId.value = row._id
  currentNotes.value = row.notes || ''
  notesVisible.value = true
}

async function saveNotes() {
  try {
    await customerApi.update(currentCustomerId.value, { notes: currentNotes.value })
    ElMessage.success('备注保存成功')
    notesVisible.value = false
    loadData()
  } catch (err) {
    ElMessage.error('保存失败')
  }
}

async function toggleBlacklist(row) {
  const action = row.is_blacklisted ? '取消黑名单' : '加入黑名单'
  try {
    const msg = row.is_blacklisted
      ? '确定要取消该客户的黑名单吗？取消后可正常预约。'
      : '确定要将该客户加入黑名单吗？加入后该客户预约时将提示"您的账号注册信息有误，请联系门店"。'
    await ElMessageBox.confirm(msg, '确认操作', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await customerApi.toggleBlacklist(row._id, !row.is_blacklisted)
    ElMessage.success(`${action}成功`)
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败')
    }
  }
}

async function deleteCustomer(row) {
  try {
    await ElMessageBox.confirm(`确定要删除客户「${row.nick_name || row.phone}」吗？删除后不可恢复。`, '确认删除', {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await customerApi.delete(row._id)
    ElMessage.success('删除成功')
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

async function viewAppointments(row) {
  if (!row.openid) {
    ElMessage.warning('该用户未绑定微信，无法查询预约记录')
    return
  }

  appointmentsLoading.value = true
  appointmentsVisible.value = true
  customerAppointments.value = []
  try {
    const data = await appointmentApi.getList({
      page: 1,
      page_size: 50,
      patient_openid: row.openid
    })
    customerAppointments.value = data.list || data || []
  } catch (err) {
    ElMessage.error(err.message || '查询预约记录失败')
    appointmentsVisible.value = false
  } finally {
    appointmentsLoading.value = false
  }
}

function formatTime(val) {
  if (!val) return '-'
  const d = new Date(val)
  if (isNaN(d.getTime())) return val
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function getStatusType(status) {
  const types = { pending: 'warning', completed: 'success', cancelled: 'info' }
  return types[status] || 'info'
}

function getStatusText(status) {
  const texts = { pending: '待核销', completed: '已完成', cancelled: '已取消' }
  return texts[status] || status
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
