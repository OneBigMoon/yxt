const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

const app = express()
const PORT = 3001

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads')
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}${ext}`)
  }
})
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } })

// 中间件
app.use(cors())
app.use(express.json())
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// 调用admin云函数
async function callAdmin(action, data = {}, id = null) {
  // 清除缓存以支持热更新
  delete require.cache[require.resolve('../cloudfunctions/admin/index.js')]
  const admin = require('../cloudfunctions/admin/index.js')
  const result = await admin.main({ action, data, id })
  if (result.code !== 0) throw new Error(result.message || '操作失败')
  return result.data
}

// ==================== 预约管理 ====================
app.get('/admin/appointments', async (req, res, next) => {
  try {
    const data = await callAdmin('getAppointments', req.query)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.get('/admin/appointments/:id', async (req, res, next) => {
  try {
    const data = await callAdmin('getAppointmentDetail', {}, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 客户管理 ====================
app.get('/admin/customers', async (req, res, next) => {
  try {
    const data = await callAdmin('getCustomers', req.query)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/customers/:id', async (req, res, next) => {
  try {
    const data = await callAdmin('updateCustomer', req.body, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/customers/:id/blacklist', async (req, res, next) => {
  try {
    const data = await callAdmin('toggleBlacklist', { is_blacklisted: req.body.is_blacklisted }, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 技师管理 ====================
app.get('/admin/technicians', async (req, res, next) => {
  try {
    const data = await callAdmin('getTechnicians')
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.post('/admin/technicians', async (req, res, next) => {
  try {
    const data = await callAdmin('createTechnician', req.body)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/technicians/:id', async (req, res, next) => {
  try {
    const data = await callAdmin('updateTechnician', req.body, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/technicians/:id/status', async (req, res, next) => {
  try {
    const data = await callAdmin('toggleTechnicianStatus', { status: req.body.status }, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 服务管理 ====================
app.get('/admin/services', async (req, res, next) => {
  try {
    const data = await callAdmin('getServices')
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.post('/admin/services', async (req, res, next) => {
  try {
    const data = await callAdmin('createService', req.body)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/services/:id', async (req, res, next) => {
  try {
    const data = await callAdmin('updateService', req.body, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 营业配置 ====================
app.get('/admin/config', async (req, res, next) => {
  try {
    const data = await callAdmin('getConfig')
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/config', async (req, res, next) => {
  try {
    const data = await callAdmin('updateConfig', req.body)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 休息管理 ====================
app.get('/admin/holidays', async (req, res, next) => {
  try {
    const data = await callAdmin('getHolidays', req.query)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.post('/admin/holidays', async (req, res, next) => {
  try {
    const data = await callAdmin('addHoliday', req.body)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.delete('/admin/holidays/:id', async (req, res, next) => {
  try {
    const data = await callAdmin('deleteHoliday', {}, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.get('/admin/tech-days-off', async (req, res, next) => {
  try {
    const data = await callAdmin('getTechDaysOff')
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.post('/admin/tech-days-off', async (req, res, next) => {
  try {
    const data = await callAdmin('addTechDayOff', req.body)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.delete('/admin/tech-days-off/:id', async (req, res, next) => {
  try {
    const data = await callAdmin('deleteTechDayOff', {}, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 提成统计 ====================
app.get('/admin/commissions', async (req, res, next) => {
  try {
    const data = await callAdmin('getCommissions', req.query)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.get('/admin/commissions/summary', async (req, res, next) => {
  try {
    const data = await callAdmin('getCommissionSummary', req.query)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 文章管理 ====================
app.get('/admin/articles', async (req, res, next) => {
  try {
    const data = await callAdmin('getArticles')
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.post('/admin/articles', async (req, res, next) => {
  try {
    const data = await callAdmin('createArticle', req.body)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/articles/:id', async (req, res, next) => {
  try {
    const data = await callAdmin('updateArticle', req.body, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

app.put('/admin/articles/:id/status', async (req, res, next) => {
  try {
    const data = await callAdmin('toggleArticleStatus', { status: req.body.status }, req.params.id)
    res.json({ code: 0, data })
  } catch (e) { next(e) }
})

// ==================== 文件上传 ====================
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ code: -1, message: '请选择文件' })
  const url = `/uploads/${req.file.filename}`
  res.json({ code: 0, data: { url } })
})

// 错误处理
app.use((err, req, res, _next) => {
  console.error('API Error:', err.message)
  res.status(500).json({ code: -1, message: err.message || '服务器错误' })
})

app.listen(PORT, () => {
  console.log(`API网关已启动: http://localhost:${PORT}`)
})
