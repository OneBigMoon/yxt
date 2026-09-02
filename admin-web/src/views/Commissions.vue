<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">提成统计</h2>
    </div>

    <div class="filter-container">
      <div class="filter-item">
        <span class="filter-label">技师：</span>
        <el-select v-model="filters.technician_id" placeholder="全部技师" clearable @change="loadData">
          <el-option
            v-for="tech in technicians"
            :key="tech._id"
            :label="tech.name"
            :value="tech._id"
          />
        </el-select>
      </div>
      <div class="filter-item">
        <span class="filter-label">日期范围：</span>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="YYYY-MM-DD"
          @change="loadData"
        />
      </div>
      <el-button type="primary" @click="loadData">查询</el-button>
    </div>

    <!-- 统计卡片 -->
    <el-row :gutter="20" style="margin-bottom: 20px;">
      <el-col :span="8">
        <el-card shadow="hover">
          <div class="summary-item">
            <div class="summary-label">总提成</div>
            <div class="summary-value">¥{{ ((summary.total || 0) / 100).toFixed(2) }}</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <div class="summary-item">
            <div class="summary-label">核销次数</div>
            <div class="summary-value">{{ summary.count }}</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <div class="summary-item">
            <div class="summary-label">平均每单提成</div>
            <div class="summary-value">¥{{ summary.count > 0 ? ((summary.total || 0) / summary.count / 100).toFixed(2) : '0.00' }}</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载提成统计失败'"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <el-table v-else :data="commissions" border v-loading="loading">
      <el-table-column prop="date" label="日期" width="120" />
      <el-table-column prop="technician_name" label="技师" width="120" />
      <el-table-column prop="service_name" label="服务项目" width="150" />
      <el-table-column label="服务价格(元)" width="120">
        <template #default="{ row }">
          {{ ((row.service_price || 0) / 100).toFixed(2) }}
        </template>
      </el-table-column>
      <el-table-column label="提成金额(元)" width="120">
        <template #default="{ row }">
          {{ ((row.commission_amount || 0) / 100).toFixed(2) }}
        </template>
      </el-table-column>
      <el-table-column label="提成类型" width="100">
        <template #default="{ row }">
          <el-tag :type="row.commission_type === 'custom' ? 'warning' : 'info'" size="small">
            {{ row.commission_type === 'custom' ? '个人提成' : '默认提成' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="核销时间" width="180">
        <template #default="{ row }">
          {{ formatTime(row.created_at) }}
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
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { commissionApi, technicianApi } from '../api'

const commissions = ref([])
const technicians = ref([])
const dateRange = ref([])
const filters = ref({ technician_id: '' })
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)
const loading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')
const summaryLoading = ref(false)

const summary = ref({
  total: 0,
  count: 0
})

onMounted(() => {
  loadTechnicians()
  loadData()
  loadSummary()
})

async function loadTechnicians() {
  try {
    technicians.value = await technicianApi.getList()
  } catch (err) {
    console.error('加载技师列表失败:', err)
    ElMessage.error('加载技师列表失败')
  }
}

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

    if (dateRange.value && dateRange.value.length === 2) {
      params.start_date = dateRange.value[0]
      params.end_date = dateRange.value[1]
    }

    const data = await commissionApi.getList(params)
    commissions.value = data.list || data || []
    total.value = data.total || commissions.value.length
    await loadSummary()
  } catch (err) {
    console.error('加载提成数据失败:', err)
    loadError.value = true
    errorMessage.value = err.message || '加载提成数据失败'
    ElMessage.error('加载提成数据失败')
    commissions.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function loadSummary() {
  summaryLoading.value = true
  try {
    const params = { ...filters.value }
    if (dateRange.value && dateRange.value.length === 2) {
      params.start_date = dateRange.value[0]
      params.end_date = dateRange.value[1]
    }

    const data = await commissionApi.getSummary(params)
    summary.value = { total: (data && data.total) || 0, count: (data && data.count) || 0 }
  } catch (err) {
    console.error('加载统计失败:', err)
    ElMessage.error('加载统计失败')
  } finally {
    summaryLoading.value = false
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

.summary-item {
  text-align: center;
  padding: 20px;
}

.summary-label {
  font-size: 14px;
  color: #909399;
  margin-bottom: 10px;
}

.summary-value {
  font-size: 28px;
  font-weight: bold;
  color: #333;
}
</style>
