<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">健康小知识管理</h2>
      <el-button
        v-if="canCreateArticle"
        type="primary"
        @click="showAddDialog"
      >
        新建文章
      </el-button>
    </div>

    <el-empty
      v-if="loadError"
      :description="errorMessage || '加载文章列表失败'"
    >
      <el-button type="primary" @click="loadData" style="margin-top: 12px;">
        重试
      </el-button>
    </el-empty>

    <el-empty v-else-if="!loading && articles.length === 0" description="暂无文章" />

    <el-table v-else :data="articles" border class="table-container" v-loading="loading">
      <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
      <el-table-column label="封面图" width="100">
        <template #default="{ row }">
          <el-image
            v-if="row.cover_image"
            :src="row.cover_image"
            :preview-src-list="[row.cover_image]"
            style="width: 60px; height: 60px;"
            fit="cover"
          />
          <span v-else>无</span>
        </template>
      </el-table-column>
      <el-table-column prop="sort_order" label="排序" width="80" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'published' ? 'success' : 'info'" size="small">
            {{ row.status === 'published' ? '已发布' : '草稿' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="180">
        <template #default="{ row }">
          {{ formatTime(row.created_at || row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="canUpdateArticle"
            type="primary"
            link
            @click="editArticle(row)"
          >
            编辑
          </el-button>
          <el-button
            v-if="canToggleArticle"
            :type="row.status === 'published' ? 'warning' : 'success'"
            link
            @click="toggleStatus(row)"
          >
            {{ row.status === 'published' ? '下架' : '发布' }}
          </el-button>
          <el-button
            v-if="canDeleteArticle"
            type="danger"
            link
            @click="deleteArticle(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 添加/编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑文章' : '新建文章'"
      width="900px"
      :close-on-click-modal="false"
      @closed="destroyEditor"
    >
      <el-form :model="formData" label-width="100px">
        <el-form-item label="标题" required>
          <el-input v-model="formData.title" placeholder="请输入文章标题" />
        </el-form-item>
        <el-form-item label="摘要">
          <el-input
            v-model="formData.summary"
            type="textarea"
            :rows="2"
            placeholder="请输入文章摘要"
          />
        </el-form-item>
        <el-form-item label="封面图">
          <el-upload
            class="cover-uploader"
            :show-file-list="false"
            :http-request="handleCoverUpload"
            :before-upload="beforeCoverUpload"
          >
            <el-image
              v-if="formData.cover_image"
              :src="formData.cover_image"
              style="width: 200px; height: 150px;"
              fit="cover"
            />
            <el-icon v-else class="cover-uploader-icon"><Plus /></el-icon>
          </el-upload>
        </el-form-item>
        <el-form-item label="正文内容" required>
          <div class="editor-wrapper">
            <Toolbar
              :editor="editorRef"
              :defaultConfig="toolbarConfig"
              :mode="'default'"
              style="border-bottom: 1px solid #ccc;"
            />
            <Editor
              v-model="formData.content"
              :defaultConfig="editorConfig"
              :mode="'default'"
              style="height: 400px; overflow-y: hidden;"
              @onCreated="handleEditorCreated"
            />
          </div>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="formData.sort_order" :min="0" />
          <span style="margin-left: 10px; color: #909399;">数字越小越靠前</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitLoading" @click="saveArticle">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, ref, shallowRef, onBeforeUnmount, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { articleApi, uploadFile } from '../api'
import '@wangeditor/editor/dist/css/style.css'
import { hasActionPermission } from '../utils/permissions'

const Editor = defineAsyncComponent(() => (
  import('@wangeditor/editor-for-vue').then(module => module.Editor)
))
const Toolbar = defineAsyncComponent(() => (
  import('@wangeditor/editor-for-vue').then(module => module.Toolbar)
))

const articles = ref([])
const dialogVisible = ref(false)
const isEdit = ref(false)
const currentId = ref('')
const loading = ref(false)
const submitLoading = ref(false)
const loadError = ref(false)
const errorMessage = ref('')

const canCreateArticle = computed(() => hasActionPermission('createArticle'))
const canUpdateArticle = computed(() => hasActionPermission('updateArticle'))
const canToggleArticle = computed(() => hasActionPermission('toggleArticleStatus'))
const canDeleteArticle = computed(() => hasActionPermission('deleteArticle'))

const formData = ref({
  title: '',
  summary: '',
  cover_image: '',
  content: '',
  sort_order: 0
})

// 编辑器实例
const editorRef = shallowRef(null)

const toolbarConfig = {
  excludeKeys: ['fullScreen', 'group-video']
}

const editorConfig = {
  placeholder: '请输入文章内容...',
  MENU_CONF: {
    uploadImage: {
      customUpload: async (file, insertFn) => {
        try {
          const url = await uploadFile(file)
          insertFn(url, '', '')
        } catch (err) {
          ElMessage.error('图片上传失败')
        }
      },
      maxFileSize: 5 * 1024 * 1024,
      allowedFileTypes: ['image/*']
    }
  }
}

function handleEditorCreated(editor) {
  editorRef.value = editor
}

function destroyEditor() {
  if (editorRef.value) {
    editorRef.value.destroy()
    editorRef.value = null
  }
}

onBeforeUnmount(() => {
  destroyEditor()
})

onMounted(() => {
  loadData()
})

async function loadData() {
  loading.value = true
  loadError.value = false
  errorMessage.value = ''
  try {
    articles.value = await articleApi.getList()
  } catch (err) {
    console.error('加载文章数据失败:', err)
    ElMessage.error('加载文章数据失败')
    loadError.value = true
    errorMessage.value = err.message || '加载文章列表失败'
    articles.value = []
  } finally {
    loading.value = false
  }
}

function showAddDialog() {
  isEdit.value = false
  formData.value = {
    title: '',
    summary: '',
    cover_image: '',
    content: '',
    sort_order: 0
  }
  dialogVisible.value = true
}

function editArticle(row) {
  isEdit.value = true
  currentId.value = row._id
  formData.value = {
    title: row.title,
    summary: row.summary || '',
    cover_image: row.cover_image || '',
    content: row.content || '',
    sort_order: row.sort_order || 0
  }
  dialogVisible.value = true
}

async function saveArticle() {
  if (!formData.value.title) {
    ElMessage.warning('请输入文章标题')
    return
  }

  submitLoading.value = true
  try {
    if (isEdit.value) {
      await articleApi.update(currentId.value, formData.value)
      ElMessage.success('更新成功')
    } else {
      await articleApi.create({
        ...formData.value,
        status: 'draft'
      })
      ElMessage.success('创建成功')
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
  const newStatus = row.status === 'published' ? 'draft' : 'published'
  const action = newStatus === 'published' ? '发布' : '下架'

  try {
    await ElMessageBox.confirm(`确定要${action}该文章吗？`, '确认操作', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await articleApi.toggleStatus(row._id, newStatus)
    ElMessage.success(`${action}成功`)
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败')
    }
  }
}

async function deleteArticle(row) {
  try {
    await ElMessageBox.confirm('确定要删除该文章吗？删除后不可恢复。', '确认删除', {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await articleApi.delete(row._id)
    ElMessage.success('删除成功')
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

async function handleCoverUpload(options) {
  try {
    const url = await uploadFile(options.file)
    formData.value.cover_image = url
    ElMessage.success('上传成功')
  } catch (err) {
    ElMessage.error('上传失败')
  }
}

function beforeCoverUpload(file) {
  const isImage = file.type.startsWith('image/')
  const isLt2M = file.size / 1024 / 1024 < 2

  if (!isImage) {
    ElMessage.error('只能上传图片文件')
    return false
  }
  if (!isLt2M) {
    ElMessage.error('图片大小不能超过 2MB')
    return false
  }
  return true
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

.cover-uploader {
  border: 1px dashed #d9d9d9;
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  width: 200px;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-uploader:hover {
  border-color: #409eff;
}

.cover-uploader-icon {
  font-size: 28px;
  color: #8c939d;
}

.editor-wrapper {
  border: 1px solid #ccc;
  border-radius: 4px;
  width: 100%;
}
</style>
