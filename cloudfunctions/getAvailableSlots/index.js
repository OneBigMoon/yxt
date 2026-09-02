const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

async function safeQuery(promise, label) {
  try {
    return await promise
  } catch (err) {
    console.error(`${label} 查询失败:`, err.message || err)
    throw err
  }
}

exports.main = async (event, context) => {
  const { date, serviceIds } = event

  try {
    // 参数校验
    const targetDate = parseYmdToDate(date)
    if (!targetDate) return { code: -1, message: '日期格式不正确' }

    const durationResult = await getAuthoritativeDuration(serviceIds)
    if (!durationResult.ok) return { code: -1, message: durationResult.message }
    const totalDuration = durationResult.duration

    // 1. 获取营业配置
    const configRes = await db.collection('business_config').limit(1).get()
    if (configRes.data.length === 0) {
      return { code: -1, message: '营业配置不存在' }
    }
    const config = configRes.data[0]
    if (!config || !config.schedule) {
      return { code: -1, message: '营业配置异常' }
    }

    // 2. 检查日期是否在可预约范围内（使用北京时间）
    const now = new Date()
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const todayStr = `${bjNow.getUTCFullYear()}-${String(bjNow.getUTCMonth() + 1).padStart(2, '0')}-${String(bjNow.getUTCDate()).padStart(2, '0')}`

    if (date < todayStr) {
      return { code: -1, message: '该日期不在可预约范围内' }
    }

    // 计算相差天数（使用日期字符串比较，避免时区问题）
    const todayParts = todayStr.split('-').map(Number)
    const dateParts = date.split('-').map(Number)
    const todayUtc = Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2])
    const targetUtc = Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2])
    const diffDays = Math.floor((targetUtc - todayUtc) / (24 * 60 * 60 * 1000))

    if (diffDays > config.max_advance_days) {
      return { code: -1, message: '该日期不在可预约范围内' }
    }

    // 并行查询：休业日、顾问、当天顾问休假、当天预约
    const [holidaysRes, techRes, daysOffRes, appointmentsRes] = await Promise.all([
      safeQuery(
        db.collection('holidays')
          .where({ date: date })
          .get(),
        '休业日'
      ),
      safeQuery(
        db.collection('technicians')
          .where({ status: 'active' })
          .get(),
        '顾问'
      ),
      safeQuery(
        db.collection('tech_days_off')
          .where({ date: date })
          .get(),
        '顾问休假'
      ),
      getAllPages(() => db.collection('appointments').where({ date, status: 'pending' }), '预约')
    ])

    // 3. 检查是否是休班日
    const holidays = (holidaysRes && holidaysRes.data) ? holidaysRes.data : []
    if (holidays.length > 0) {
      return { code: 0, data: [] }
    }

    // 4. 获取该日期是周几（1-7，周日为7）
    const targetDateObj = targetDate
    const dayOfWeek = targetDateObj.getUTCDay() || 7

    // 5. 获取该日的营业时间段
    const workHours = config.schedule && config.schedule[dayOfWeek]
    if (!Array.isArray(workHours) || workHours.length === 0) {
      return { code: 0, data: [] }
    }

    // 6. 获取当天上班顾问数
    const techResData = (techRes && techRes.data) ? techRes.data : []
    let techCount = techResData.length
    const activeTechnicianIds = new Set(techResData.map(tech => tech._id).filter(Boolean))

    // 减去当天休假的顾问
    const daysOffResData = (daysOffRes && daysOffRes.data) ? daysOffRes.data : []
    techCount -= countActiveTechnicianDaysOff(daysOffResData, activeTechnicianIds)
    techCount = Math.max(techCount, 0)

    if (techCount === 0) {
      return { code: 0, data: [] }
    }

    // 7. 获取该日所有已有预约（pending状态）
    const appointments = appointmentsRes || []

    // 8. 生成候选时段
    const slotInterval = config.slot_interval || 30
    const slots = []

    for (const period of workHours) {
      const periodStart = timeToMinutes(period && period.start)
      const periodEnd = timeToMinutes(period && period.end)
      if (periodStart === null || periodEnd === null || periodStart >= periodEnd) {
        continue
      }

      for (let time = periodStart; time + totalDuration <= periodEnd; time += slotInterval) {
        const startTime = minutesToTime(time)
        const endTime = minutesToTime(time + totalDuration)

        // 检查该时段的已预约数（前后相接不算冲突）
        let bookedCount = 0
        for (const apt of appointments) {
          if (!apt || !apt.start_time || !apt.end_time) {
            continue
          }
          const aptStart = timeToMinutes(apt.start_time)
          const aptEnd = timeToMinutes(apt.end_time)
          if (aptStart === null || aptEnd === null) {
            continue
          }
          const slotStart = time
          const slotEnd = time + totalDuration

          // 严格重叠：新时段开始 < 已约结束 且 已约开始 < 新时段结束
          // 前后相接（如 17:30 结束 vs 17:30 开始）不算冲突
          if (slotStart < aptEnd && aptStart < slotEnd) {
            bookedCount++
          }
        }

        const remaining = techCount - bookedCount
        const available = remaining > 0

        // 如果是今天，排除已过去的时段（北京时间）
        if (date === todayStr) {
          const currentMinutes = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()
          if (time <= currentMinutes) {
            continue
          }
        }

        slots.push({
          time: `${startTime}-${endTime}`,
          remaining: remaining,
          available: available
        })
      }
    }

    return { code: 0, data: slots }
  } catch (err) {
    console.error('获取可用时段失败:', err)
    return { code: -1, message: '获取可用时段失败，请稍后重试' }
  }
}

// 时间字符串转分钟数
function timeToMinutes(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) return null
  const [hours, minutes] = timeStr.split(':').map(Number)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

// 分钟数转时间字符串
function minutesToTime(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return ''
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

function countActiveTechnicianDaysOff(daysOffRecords, activeTechnicianIds) {
  return (daysOffRecords || []).filter(record =>
    record && activeTechnicianIds.has(record.technician_id)
  ).length
}

function parseYmdToDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const parts = dateStr.split('-').map(Number)
  const [year, month, day] = parts
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null
  return parsed
}

async function getAuthoritativeDuration(serviceIds) {
  if (serviceIds === undefined || (Array.isArray(serviceIds) && serviceIds.length === 0)) {
    return { ok: true, duration: 30 }
  }
  if (!Array.isArray(serviceIds) || serviceIds.length > 10) {
    return { ok: false, message: '服务项目参数异常，请刷新后重试' }
  }

  const ids = [...new Set(serviceIds.map(id => String(id || '').trim()).filter(Boolean))]
  if (ids.length === 0 || ids.length !== serviceIds.length) {
    return { ok: false, message: '服务项目参数异常，请刷新后重试' }
  }

  const result = await db.collection('services').where({ _id: _.in(ids) }).get()
  const services = (result.data || []).filter(service => service.status === 'active')
  const duration = services.reduce((sum, service) => sum + Number(service.duration || 0), 0)
  if (services.length !== ids.length || !Number.isInteger(duration) || duration <= 0 || duration > 480) {
    return { ok: false, message: '服务项目已调整，请刷新后重新选择' }
  }
  return { ok: true, duration }
}

async function getAllPages(makeQuery, label) {
  const data = []
  const pageSize = 100
  for (let skip = 0; ; skip += pageSize) {
    const result = await safeQuery(makeQuery().skip(skip).limit(pageSize).get(), label)
    const page = result.data || []
    data.push(...page)
    if (page.length < pageSize) return data
  }
}
