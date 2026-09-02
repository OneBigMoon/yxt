<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">操作审计日志</h2>
    </div>

    <div class="filter-container">
      <div class="filter-item">
        <span class="filter-label">管理员账号ID</span>
        <el-input
          v-model="filters.admin_user_id"
          placeholder="输入管理员账号ID"
          clearable
          @keyup.enter="loadData"
        />
      </div>
      <div class="filter-item">
        <span class="filter-label">动作</span>
        <el-input
          v-model="filters.action"
          placeholder="输入动作关键字（如 admin.update）"
          clearable
          @keyup.enter="loadData"
        />
      </div>
      <el-button type="primary" @click="loadData">查询</el-button>
    </div>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载审计日志失败'"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <el-table v-else :data="logs" border v-loading="loading">
      <el-table-column prop="created_at" label="时间" width="180">
        <template #default="{ row }">
          {{ formatTime(row.created_at) }}
        </template>
      </el-table-column>
      <el-table-column prop="admin_username" label="操作者" width="140">
        <template #default="{ row }">
          {{ row.admin_username || '-' }}
        </template>
      </el-table-column>
      <el-table-column prop="role" label="角色" width="110" />
      <el-table-column prop="action" label="动作" width="220">
        <template #default="{ row }">
          <el-text class="action-text">{{ row.action }}</el-text>
        </template>
      </el-table-column>
      <el-table-column prop="target_type" label="对象" width="130" />
      <el-table-column prop="target_id" label="对象ID" width="220" show-overflow-tooltip />
      <el-table-column prop="status" label="结果" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'success' ? 'success' : 'warning'">
            {{ row.status || 'success' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="message" label="说明" min-width="240" show-overflow-tooltip />
      <el-table-column prop="trace_id" label="TraceID" min-width="150" show-overflow-tooltip />
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
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { auditApi } from '../api'

const logs = ref([])
const filters = ref({
  admin_user_id: '',
  action: ''
})
const loading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)

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
    const data = await auditApi.getList(params)
    logs.value = data.list || []
    total.value = data.total || 0
    currentPage.value = data.page || currentPage.value
    pageSize.value = data.page_size || pageSize.value
  } catch (err) {
    loading.value = false
    loadError.value = true
    errorMessage.value = err.message || '加载审计日志失败'
    ElMessage.error(errorMessage.value)
    logs.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function formatTime(val) {
  if (!val) {
    return '-'
  }
  const d = val.$date ? new Date(val.$date) : new Date(val)
  if (Number.isNaN(d.getTime())) {
    return '-'
  }
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.page-container {
  background-color: #fff;
  border-radius: 4px;
  padding: 20px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
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

.filter-container {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.filter-label {
  margin-right: 8px;
  font-size: 14px;
  color: #606266;
}

.pagination-container {
  margin-top: 18px;
  display: flex;
  justify-content: flex-end;
}

.action-text {
  display: inline-block;
  max-width: 100%;
}
</style>
