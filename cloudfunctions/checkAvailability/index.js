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
  const { OPENID } = cloud.getWXContext()
  const { serviceIds } = event

  try {
    // 0. 检查是否被拉黑
    const userRes = await safeQuery(
      db.collection('users')
        .where({ openid: OPENID })
        .get(),
      '用户'
    )

    if (userRes && userRes.data.length > 0 && userRes.data[0].is_blacklisted) {
      return {
        code: 0,
        data: {
          hasAnyAvailable: false,
          dateStatus: {},
          message: '该账号暂无法预约，请联系门店处理',
          reason_code: 'BLACKLISTED'
        }
      }
    }

    // 1. 获取营业配置
    const configRes = await db.collection('business_config').limit(1).get()
    if (configRes.data.length === 0) {
      return { code: -1, message: '营业配置不存在' }
    }
    const config = configRes.data[0]

    const durationResult = await getAuthoritativeDuration(serviceIds)
    if (!durationResult.ok) return { code: -1, message: durationResult.message }
    const totalDuration = durationResult.duration

    // 2. 获取基本信息
    const maxDays = config.max_advance_days || 14
    const slotInterval = config.slot_interval || 30

    const now = new Date()
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const currentMinutes = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()

    const todayStr = formatDate(bjNow)
    const endDate = new Date(bjNow.getTime() + maxDays * 24 * 60 * 60 * 1000)
    const endStr = formatDate(endDate)

    // 3. 并发查询：节假日、顾问、顾问休假、当前待预约
    const [holidayQueryRes, techRes, daysOffRes, aptRes] = await Promise.all([
      safeQuery(
        db.collection('holidays').get(),
        '休业日'
      ),
      safeQuery(
        db.collection('technicians')
          .where({ status: 'active' })
          .get(),
        '顾问'
      ),
      safeQuery(
        db.collection('tech_days_off').get(),
        '顾问休假'
      ),
      getAllPages(
        () => db.collection('appointments').where({
          date: _.gte(todayStr).and(_.lte(endStr)),
          status: 'pending'
        }),
        '预约'
      )
    ])

    const holidaysRes = (holidayQueryRes && holidayQueryRes.data) ? holidayQueryRes.data : []
    const holidaysMap = {}
    holidaysRes.forEach((h) => {
      holidaysMap[h.date] = h.reason || '停业'
    })

    const techResData = (techRes && techRes.data) ? techRes.data : []
    const daysOffResData = (daysOffRes && daysOffRes.data) ? daysOffRes.data : []
    const allAppointments = aptRes || []

    // 4. 获取顾问数量
    const techCount = techResData.length
    if (techCount <= 0) {
      return {
        code: 0,
        data: {
          hasAnyAvailable: false,
          dateStatus: {},
          message: '暂无可预约顾问，请联系门店',
          reason_code: 'NO_ACTIVE_TECHNICIAN'
        }
      }
    }

    const activeTechnicianIds = new Set(techResData.map(tech => tech._id).filter(Boolean))
    const daysOffMap = {}
    for (const d of daysOffResData) {
      if (!d || !activeTechnicianIds.has(d.technician_id)) {
        continue
      }
      daysOffMap[d.date] = (daysOffMap[d.date] || 0) + 1
    }

    // 按日期分组预约
    const appointmentsByDate = {}
    for (const apt of allAppointments) {
      if (!appointmentsByDate[apt.date]) appointmentsByDate[apt.date] = []
      appointmentsByDate[apt.date].push(apt)
    }

    // 5. 逐日检查状态
    const dateStatus = {}
    const statusCounts = {
      closure: 0,
      rest: 0,
      noTechnician: 0,
      full: 0,
      available: 0
    }
    let hasAnyAvailable = false

    for (let d = 0; d <= maxDays; d++) {
      const checkDate = new Date(bjNow.getTime() + d * 24 * 60 * 60 * 1000)
      const dateStr = formatDate(checkDate)

      // 停业日
      if (holidaysMap[dateStr]) {
        dateStatus[dateStr] = { status: 'closure', reason: holidaysMap[dateStr] }
        statusCounts.closure++
        continue
      }

      // 休息日
      const dayOfWeek = checkDate.getUTCDay() || 7
      const workHours = config.schedule && config.schedule[dayOfWeek]
      if (!Array.isArray(workHours) || workHours.length === 0) {
        dateStatus[dateStr] = { status: 'rest' }
        statusCounts.rest++
        continue
      }

      // 无顾问
      let dayTechCount = techCount - (daysOffMap[dateStr] || 0)
      if (dayTechCount <= 0) {
        dateStatus[dateStr] = { status: 'full', reason: 'no_technician' }
        statusCounts.noTechnician++
        continue
      }

      // 检查是否有可用时段
      const minDuration = totalDuration
      const appointments = appointmentsByDate[dateStr] || []
      let hasSlot = false

      for (const period of workHours) {
        const periodStart = timeToMinutes(period && period.start)
        const periodEnd = timeToMinutes(period && period.end)
        if (periodStart === null || periodEnd === null || periodStart >= periodEnd) {
          continue
        }

        for (let time = periodStart; time + minDuration <= periodEnd; time += slotInterval) {
          // 今天跳过已过去的时段
          if (d === 0 && time <= currentMinutes) continue

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
            if (time < aptEnd && aptStart < time + minDuration) {
              bookedCount++
            }
          }

          if (dayTechCount - bookedCount > 0) {
            hasSlot = true
            break
          }
        }
        if (hasSlot) break
      }

      if (hasSlot) {
        dateStatus[dateStr] = { status: 'available' }
        statusCounts.available++
        hasAnyAvailable = true
      } else {
        dateStatus[dateStr] = { status: 'full', reason: 'booked_or_no_slot' }
        statusCounts.full++
      }
    }

    const unavailableReason = getUnavailableReason(statusCounts, maxDays)

    return {
      code: 0,
      data: {
        hasAnyAvailable,
        dateStatus,
        message: hasAnyAvailable ? '' : unavailableReason.message,
        reason_code: hasAnyAvailable ? '' : unavailableReason.code
      }
    }
  } catch (err) {
    console.error('检查可用性失败:', err)
    return { code: -1, message: '检查可用性失败，请稍后重试' }
  }
}

function countActiveTechnicianDaysOff(daysOffRecords, activeTechnicianIds) {
  return (daysOffRecords || []).filter(record =>
    record && activeTechnicianIds.has(record.technician_id)
  ).length
}

function getUnavailableReason(statusCounts, maxDays) {
  const totalDays = maxDays + 1
  const nonBusinessDays = statusCounts.rest + statusCounts.closure

  if (nonBusinessDays >= totalDays) {
    return {
      code: 'NO_BUSINESS_HOURS',
      message: '当前暂无可预约营业日，请联系门店'
    }
  }

  if (statusCounts.noTechnician > 0 && statusCounts.full === 0) {
    return {
      code: 'NO_TECHNICIAN_ON_DUTY',
      message: '可预约日期暂无顾问排班，请联系门店'
    }
  }

  return {
    code: 'FULLY_BOOKED',
    message: `${maxDays}天内预约已满，请稍后再试`
  }
}

function timeToMinutes(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) return null
  const [hours, minutes] = timeStr.split(':').map(Number)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
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

function formatDate(bjDate) {
  const year = bjDate.getUTCFullYear()
  const month = String(bjDate.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bjDate.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
