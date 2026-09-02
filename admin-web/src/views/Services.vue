<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">服务管理</h2>
      <el-button
        v-if="canCreateService"
        type="primary"
        @click="showAddDialog"
      >
        添加服务
      </el-button>
    </div>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载服务列表失败'"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <el-empty v-else-if="!loading && services.length === 0" description="暂无服务" />

    <el-table v-else :data="services" border class="table-container" v-loading="loading">
      <el-table-column label="图片" width="80">
        <template #default="{ row }">
          <el-image
            v-if="row.image_url"
            :src="row.image_url"
            fit="cover"
            style="width: 50px; height: 50px; border-radius: 4px;"
          />
          <span v-else style="color: #ccc; font-size: 12px;">无图</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="服务名称" width="150" />
      <el-table-column prop="duration" label="时长(分钟)" width="120" />
      <el-table-column label="价格(元)" width="120">
        <template #default="{ row }">
          {{ ((row.price || 0) / 100).toFixed(2) }}
        </template>
      </el-table-column>
      <el-table-column label="默认提成(元)" width="120">
        <template #default="{ row }">
          {{ ((row.default_commission || 0) / 100).toFixed(2) }}
        </template>
      </el-table-column>
      <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '启用' : '禁用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="sort_order" label="排序" width="80" />
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="canUpdateService"
            type="primary"
            link
            @click="editService(row)"
          >
            编辑
          </el-button>
          <el-button
            v-if="canToggleService"
            :type="row.status === 'active' ? 'warning' : 'success'"
            link
            @click="toggleStatus(row)"
          >
            {{ row.status === 'active' ? '禁用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 添加/编辑弹窗 -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑服务' : '添加服务'" width="600px">
      <el-form :model="formData" label-width="120px">
        <el-form-item label="服务图片">
          <el-upload
            :show-file-list="false"
            :http-request="handleImageUpload"
            accept="image/*"
          >
            <el-image
              v-if="formData.image_url"
              :src="formData.image_url"
              fit="cover"
              style="width: 100px; height: 100px; border-radius: 4px; border: 1px solid #ddd;"
            />
            <el-button v-else size="small">上传图片</el-button>
          </el-upload>
        </el-form-item>
        <el-form-item label="服务名称" required>
          <el-input v-model="formData.name" placeholder="请输入服务名称" />
        </el-form-item>
        <el-form-item label="时长(分钟)" required>
          <el-input-number v-model="formData.duration" :min="15" :step="15" />
        </el-form-item>
        <el-form-item label="价格(元)" required>
          <el-input-number v-model="formData.price" :min="0" :precision="2" :step="10" />
        </el-form-item>
        <el-form-item label="默认提成(元)" required>
          <el-input-number v-model="formData.default_commission" :min="0" :precision="2" :step="10" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="formData.description" type="textarea" :rows="3" placeholder="请输入服务描述" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="formData.sort_order" :min="0" />
          <span style="margin-left: 10px; color: #909399;">数字越小越靠前</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitLoading" @click="saveService">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { serviceApi, uploadFile } from '../api'
import { hasActionPermission } from '../utils/permissions'

const services = ref([])
const dialogVisible = ref(false)
const isEdit = ref(false)
const currentId = ref('')
const loading = ref(false)
const submitLoading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')

const canCreateService = computed(() => hasActionPermission('createService'))
const canUpdateService = computed(() => hasActionPermission('updateService'))
const canToggleService = computed(() => canUpdateService.value)

const formData = ref({
  name: '',
  duration: 60,
  price: 0,
  default_commission: 0,
  description: '',
  sort_order: 0,
  image_url: ''
})

async function handleImageUpload(options) {
  try {
    const url = await uploadFile(options.file)
    formData.value.image_url = url
    ElMessage.success('图片上传成功')
  } catch (err) {
    ElMessage.error('图片上传失败')
  }
}

onMounted(() => {
  loadData()
})

async function loadData() {
  loading.value = true
  loadError.value = false
  errorMessage.value = ''
  try {
    services.value = await serviceApi.getList()
  } catch (err) {
    console.error('加载服务数据失败:', err)
    ElMessage.error('加载服务数据失败')
    loadError.value = true
    errorMessage.value = err.message || '加载服务列表失败'
    services.value = []
  } finally {
    loading.value = false
  }
}

function showAddDialog() {
  isEdit.value = false
  formData.value = {
    name: '',
    duration: 60,
    price: 0,
    default_commission: 0,
    description: '',
    sort_order: 0,
    image_url: ''
  }
  dialogVisible.value = true
}

function editService(row) {
  isEdit.value = true
  currentId.value = row._id
  formData.value = {
    name: row.name,
    duration: row.duration,
    price: (row.price || 0) / 100,
    default_commission: (row.default_commission || 0) / 100,
    description: row.description || '',
    sort_order: row.sort_order || 0,
    image_url: row.image_url || ''
  }
  dialogVisible.value = true
}

async function saveService() {
  if (!formData.value.name.trim()) {
    ElMessage.warning('请填写服务名称')
    return
  }

  const duration = Number(formData.value.duration)
  const price = Number(formData.value.price)
  const commission = Number(formData.value.default_commission)

  if (!Number.isFinite(duration) || duration < 15) {
    ElMessage.warning('服务时长至少为 15 分钟')
    return
  }

  if (!Number.isFinite(price) || price < 0) {
    ElMessage.warning('服务价格不能小于 0')
    return
  }

  if (!Number.isFinite(commission) || commission < 0) {
    ElMessage.warning('默认提成不能小于 0')
    return
  }

  if (commission > price) {
    ElMessage.warning('默认提成不能大于服务价格')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      ...formData.value,
      price: Math.round((formData.value.price || 0) * 100),
      default_commission: Math.round((formData.value.default_commission || 0) * 100)
    }

    if (isEdit.value) {
      await serviceApi.update(currentId.value, data)
      ElMessage.success('更新成功')
    } else {
      await serviceApi.create(data)
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
    await ElMessageBox.confirm(`确定要${action}该服务吗？`, '确认操作', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await serviceApi.update(row._id, { status: newStatus })
    ElMessage.success(`${action}成功`)
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败')
    }
  }
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
