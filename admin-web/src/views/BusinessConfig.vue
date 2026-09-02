<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">营业设置</h2>
    </div>

    <el-form :model="config" label-width="120px" style="max-width: 920px;" :disabled="loading || !canManageConfig">
      <el-divider content-position="left">店铺信息</el-divider>
      <el-form-item label="店铺名称">
        <el-input v-model="config.store.name" placeholder="请输入店铺名称" />
      </el-form-item>
      <el-form-item label="联系电话">
        <el-input v-model="config.store.phone" placeholder="请输入联系电话" />
      </el-form-item>
      <el-form-item label="店铺地址">
        <el-input v-model="config.store.address" placeholder="请输入店铺地址" />
      </el-form-item>
      <el-form-item label="纬度">
        <el-input-number v-model="config.store.latitude" :precision="6" :step="0.000001" />
      </el-form-item>
      <el-form-item label="经度">
        <el-input-number v-model="config.store.longitude" :precision="6" :step="0.000001" />
      </el-form-item>

      <el-divider content-position="left">营业时间</el-divider>
      <el-form-item label="时段间隔(分钟)">
        <el-input-number v-model="config.slot_interval" :min="15" :step="15" />
      </el-form-item>
      <el-form-item label="可预约天数">
        <el-input-number v-model="config.max_advance_days" :min="1" :max="30" />
      </el-form-item>

      <el-form-item v-for="day in weekDays" :key="day.value" :label="day.label">
        <div class="schedule-item">
          <div v-for="(period, index) in config.schedule[day.value]" :key="index" class="period-item">
            <el-time-picker v-model="period.start" format="HH:mm" value-format="HH:mm" placeholder="开始时间" style="width: 120px;" />
            <span style="margin: 0 10px;">至</span>
            <el-time-picker v-model="period.end" format="HH:mm" value-format="HH:mm" placeholder="结束时间" style="width: 120px;" />
            <el-button type="danger" link @click="removePeriod(day.value, index)" style="margin-left: 10px;">删除</el-button>
          </div>
          <el-button v-if="config.schedule[day.value].length < 3" type="primary" link @click="addPeriod(day.value)">添加时段</el-button>
          <el-button v-if="config.schedule[day.value].length > 0" type="warning" link @click="clearDay(day.value)">设为休息</el-button>
        </div>
      </el-form-item>

      <el-divider content-position="left">卡片管理</el-divider>
      <el-form-item label="首页组件">
        <div class="config-list">
          <div v-for="item in config.home_cards" :key="item.key" class="config-row">
            <el-switch v-model="item.enabled" />
            <el-input v-model="item.title" style="width: 180px;" disabled />
          </div>
        </div>
      </el-form-item>

      <el-form-item label="本店设施">
        <div class="config-list">
          <div v-for="(item, index) in config.facilities" :key="index" class="config-row">
            <el-switch v-model="item.enabled" />
            <el-input v-model="item.name" placeholder="设施名称" style="width: 140px;" />
            <el-select v-model="item.icon" placeholder="图标" style="width: 140px;">
              <el-option v-for="icon in facilityIconOptions" :key="icon.value" :label="icon.label" :value="icon.value" />
            </el-select>
            <el-input-number v-model="item.sort" :min="1" :max="99" controls-position="right" />
            <el-button type="danger" link @click="removeFacility(index)">删除</el-button>
          </div>
          <el-button type="primary" link @click="addFacility">添加设施</el-button>
        </div>
      </el-form-item>

      <el-form-item label="优秀技师">
        <div class="config-list">
          <div v-for="(item, index) in config.recommended_technicians" :key="index" class="config-row">
            <el-switch v-model="item.enabled" />
            <el-input v-model="item.name" placeholder="姓名" style="width: 120px;" />
            <el-input v-model="item.specialty" placeholder="擅长说明" style="width: 220px;" />
            <el-input-number v-model="item.sort" :min="1" :max="99" controls-position="right" />
            <el-button type="danger" link @click="removeRecommendedTechnician(index)">删除</el-button>
          </div>
          <el-button type="primary" link @click="addRecommendedTechnician">添加技师卡</el-button>
        </div>
      </el-form-item>

      <el-form-item>
        <el-button v-if="canManageConfig" type="primary" @click="saveConfig" :loading="saving || loading">保存设置</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { configApi } from '../api'
import { hasActionPermission } from '../utils/permissions'

const defaultHomeCards = [
  { key: 'business_status', title: '门诊营业状态', enabled: true, sort: 1 },
  { key: 'recommended_technicians', title: '优秀技师', enabled: true, sort: 2 },
  { key: 'wellness_classroom', title: '养生小课堂', enabled: true, sort: 3 }
]

const defaultFacilities = [
  { name: '门口停车', icon: 'logistics', enabled: true, sort: 1 },
  { name: '等候座椅', icon: 'friends-o', enabled: true, sort: 2 },
  { name: '可拨门店', icon: 'phone-o', enabled: true, sort: 3 }
]

const defaultTechnicians = [
  { name: '李技师', specialty: '擅长颈肩调理', enabled: true, sort: 1 },
  { name: '王技师', specialty: '擅长脾胃养护', enabled: true, sort: 2 }
]

const facilityIconOptions = [
  { label: '停车/到店', value: 'logistics' },
  { label: '座椅/等候', value: 'friends-o' },
  { label: '电话', value: 'phone-o' },
  { label: '门店', value: 'shop-o' },
  { label: '位置', value: 'location-o' }
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createDefaultConfig() {
  return {
    store: {
      name: '市中壹心堂门诊部',
      phone: '',
      address: '山东省济南市市中区七贤街道绿地国际城百花明都13号楼临街一层南起第二间',
      latitude: 36.595557,
      longitude: 116.955628
    },
    schedule: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] },
    slot_interval: 30,
    max_advance_days: 14,
    home_cards: clone(defaultHomeCards),
    facilities: clone(defaultFacilities),
    recommended_technicians: clone(defaultTechnicians)
  }
}

const config = ref(createDefaultConfig())
const saving = ref(false)
const loading = ref(false)
const canManageConfig = computed(() => hasActionPermission('updateConfig'))

const weekDays = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 }
]

onMounted(() => {
  loadConfig()
})

function normalizeHomeCards(items) {
  const source = Array.isArray(items) ? items : []
  return clone(defaultHomeCards).map(defaultItem => {
    const saved = source.find(item => item && item.key === defaultItem.key) || {}
    return { ...defaultItem, ...saved, key: defaultItem.key }
  }).sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
}

function normalizeList(items, defaults) {
  const source = Array.isArray(items) ? items : defaults
  return clone(source).map((item, index) => ({
    ...item,
    enabled: item.enabled !== false,
    sort: Number(item.sort || index + 1)
  })).sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
}

async function loadConfig() {
  loading.value = true
  try {
    const data = await configApi.get()
    const defaults = createDefaultConfig()
    config.value = {
      ...defaults,
      ...(data || {}),
      store: { ...defaults.store, ...(data && data.store ? data.store : {}) },
      schedule: data && data.schedule ? data.schedule : defaults.schedule,
      slot_interval: data && data.slot_interval ? data.slot_interval : 30,
      max_advance_days: data && data.max_advance_days ? data.max_advance_days : 14,
      home_cards: normalizeHomeCards(data && data.home_cards),
      facilities: normalizeList(data && data.facilities, defaultFacilities),
      recommended_technicians: normalizeList(data && data.recommended_technicians, defaultTechnicians)
    }
  } catch (err) {
    console.error('加载配置失败:', err)
    ElMessage.error('加载配置失败')
  } finally {
    loading.value = false
  }
}

function addPeriod(day) {
  config.value.schedule[day].push({ start: '09:00', end: '12:00' })
}

function removePeriod(day, index) {
  config.value.schedule[day].splice(index, 1)
}

function clearDay(day) {
  config.value.schedule[day] = []
}

function addFacility() {
  config.value.facilities.push({ name: '新设施', icon: 'shop-o', enabled: true, sort: config.value.facilities.length + 1 })
}

function removeFacility(index) {
  config.value.facilities.splice(index, 1)
}

function addRecommendedTechnician() {
  config.value.recommended_technicians.push({ name: '技师', specialty: '擅长中医调理', enabled: true, sort: config.value.recommended_technicians.length + 1 })
}

function removeRecommendedTechnician(index) {
  config.value.recommended_technicians.splice(index, 1)
}

async function saveConfig() {
  if (!canManageConfig.value) {
    ElMessage.warning('暂无权限修改配置')
    return
  }

  if (!config.value.store.name.trim()) {
    ElMessage.warning('请填写店铺名称')
    return
  }

  if (config.value.store.phone && !/^1\d{10}$/.test(config.value.store.phone.trim())) {
    ElMessage.warning('请输入有效手机号')
    return
  }

  if (config.value.slot_interval < 15 || config.value.max_advance_days < 1 || config.value.max_advance_days > 60) {
    ElMessage.warning('营业参数不合法，请检查时段间隔和可预约天数')
    return
  }

  saving.value = true
  try {
    await configApi.update(clone(config.value))
    ElMessage.success('保存成功')
  } catch (err) {
    ElMessage.error('保存失败')
  } finally {
    saving.value = false
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

.schedule-item,
.config-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.period-item,
.config-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
