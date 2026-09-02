const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const APPOINTMENT_CREATED_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_CREATED || ''
const BOOKING_CREATE_COOLDOWN_MS = 30 * 1000
const BOOKING_LOCK_TTL_MS = 30000
const BOOKING_LOCK_RETRY_COUNT = 8

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { services, date, start_time, end_time, total_duration } = event
  const hasRequestId = event.request_id !== undefined && event.request_id !== null
  const requestId = String(event.request_id || '').trim()

  try {
    if (!OPENID) {
      return { code: -1, message: '请先登录后预约' }
    }
    if (!Array.isArray(services) || services.length === 0 || services.length > 10) {
      return { code: -1, message: '请选择服务项目' }
    }
    if (!date || !start_time) {
      return { code: -1, message: '请选择预约日期和时段' }
    }
    if (hasRequestId && !/^[a-zA-Z0-9_-]{8,64}$/.test(requestId)) {
      return { code: -1, message: '预约请求参数异常，请刷新后重试' }
    }

    const serviceIds = [...new Set(services.map(id => String(id || '').trim()).filter(Boolean))]
    if (serviceIds.length !== services.length) {
      return { code: -1, message: '服务项目参数异常，请刷新后重试' }
    }

    const userRes = await db.collection('users')
      .where({ openid: OPENID })
      .limit(1)
      .get()

    if (!userRes.data || userRes.data.length === 0) {
      return { code: -1, message: '请先登录后预约' }
    }
    const user = userRes.data[0]
    if (user.is_blacklisted) {
      return { code: -1, message: '该账号暂无法预约，请联系门店处理' }
    }

    const now = new Date()
    const requestFingerprint = createRequestFingerprint(OPENID, serviceIds, date, start_time)
    const bookingAttempt = await reserveBookingAttempt(
      user._id,
      requestId,
      requestFingerprint,
      now.getTime()
    )
    if (bookingAttempt.status === 'cached') {
      return { code: 0, data: bookingAttempt.data }
    }
    if (bookingAttempt.status === 'conflict') {
      return { code: -1, message: '预约请求已变化，请重新提交' }
    }
    if (bookingAttempt.status !== 'reserved') {
      return { code: -1, message: '操作过于频繁，请稍后重试' }
    }

    const servicesRes = await db.collection('services')
      .where({ _id: _.in(serviceIds) })
      .get()
    const activeServices = (servicesRes.data || []).filter(service => service.status === 'active')
    if (activeServices.length !== serviceIds.length) {
      return { code: -1, message: '服务项目已调整，请刷新后重新选择' }
    }
    const authoritativeDuration = activeServices.reduce((sum, service) => {
      return sum + Number(service.duration || 0)
    }, 0)
    if (!Number.isInteger(authoritativeDuration) || authoritativeDuration <= 0 || authoritativeDuration > 480) {
      return { code: -1, message: '服务时长配置异常，请联系门店' }
    }

    const holidaysRes = await db.collection('holidays')
      .where({ date })
      .limit(1)
      .get()
    if (holidaysRes.data.length > 0) {
      return { code: -1, message: '该日期为停业日，不可预约' }
    }

    const configRes = await db.collection('business_config').limit(1).get()
    if (configRes.data.length === 0) {
      return { code: -1, message: '营业配置不存在' }
    }

    const config = configRes.data[0]
    if (!config || !config.schedule) {
      return { code: -1, message: '营业配置异常' }
    }

    const targetDate = parseYmdToDate(date)
    if (!targetDate) {
      return { code: -1, message: '日期格式不正确' }
    }

    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const today = formatDateBj(bjNow)
    const todayDate = parseYmdToDate(today)
    const diffDays = Math.round((targetDate.getTime() - todayDate.getTime()) / 86400000)
    const maxAdvanceDays = Number(config.max_advance_days || 14)
    if (diffDays < 0 || diffDays > maxAdvanceDays) {
      return { code: -1, message: '该日期不在可预约范围内' }
    }

    const dayOfWeek = targetDate.getUTCDay() || 7
    const workHours = config.schedule[dayOfWeek]
    if (!Array.isArray(workHours) || workHours.length === 0) {
      return { code: -1, message: '该时段不在营业时间内' }
    }

    const startMinutes = timeToMinutes(start_time)
    if (startMinutes === null) {
      return { code: -1, message: '时间参数格式错误' }
    }
    const endMinutes = startMinutes + authoritativeDuration
    const authoritativeEndTime = minutesToTime(endMinutes)
    if ((total_duration !== undefined && Number(total_duration) !== authoritativeDuration) ||
        (end_time && String(end_time) !== authoritativeEndTime)) {
      return { code: -1, message: '服务或时段已调整，请刷新后重新选择' }
    }
    if (date === today) {
      const currentMinutes = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()
      if (startMinutes <= currentMinutes) {
        return { code: -1, message: '不能预约已经开始或过去的时段' }
      }
    }

    const slotInterval = Number(config.slot_interval || 30)
    let inWorkHours = false

    for (const period of workHours) {
      const periodStart = timeToMinutes(period && period.start)
      const periodEnd = timeToMinutes(period && period.end)
      if (periodStart === null || periodEnd === null || periodStart >= periodEnd) {
        continue
      }

      if (startMinutes >= periodStart && endMinutes <= periodEnd &&
          Number.isInteger(slotInterval) && slotInterval >= 15 &&
          (startMinutes - periodStart) % slotInterval === 0) {
        inWorkHours = true
        break
      }
    }

    if (!inWorkHours) {
      return { code: -1, message: '该时段不在营业时间内' }
    }

    const techRes = await db.collection('technicians')
      .where({ status: 'active' })
      .get()
    let techCount = techRes.data.length
    const activeTechnicianIds = new Set(techRes.data.map(tech => tech._id).filter(Boolean))

    const daysOffRes = await db.collection('tech_days_off')
      .where({ date: date })
      .get()
    techCount -= countActiveTechnicianDaysOff(daysOffRes.data, activeTechnicianIds)
    techCount = Math.max(techCount, 0)
    if (techCount <= 0) {
      return { code: -1, message: '该日期暂无可预约顾问' }
    }

    const bookingLock = await acquireBookingLock(date)
    let booking
    let committed = false
    try {
      const allAppointments = await getAllAppointmentsByDate(date)
      const existingRequest = requestId && allAppointments.find(appointment => {
        return appointment && appointment.patient_openid === OPENID && appointment.request_id === requestId
      })
      if (existingRequest) {
        if (existingRequest.request_fingerprint !== requestFingerprint) {
          return { code: -1, message: '预约请求已变化，请重新提交' }
        }
        const existingResult = {
          _id: existingRequest._id,
          qr_code: existingRequest.qr_code || ''
        }
        await completeBookingAttempt(user._id, requestId, requestFingerprint, existingResult)
          .catch(err => console.error('记录预约幂等结果失败:', err))
        return {
          code: 0,
          data: existingResult
        }
      }
      const relevantAppointments = allAppointments.filter(appointment => {
        return appointment && ['pending', 'completed'].includes(appointment.status)
      })

      let conflictCount = 0
      let hasOwnConflict = false
      for (const apt of relevantAppointments) {
        const aptStart = timeToMinutes(apt.start_time)
        const aptEnd = timeToMinutes(apt.end_time)
        if (aptStart === null || aptEnd === null) continue
        if (startMinutes < aptEnd && endMinutes > aptStart) {
          conflictCount++
          if (apt.patient_openid === OPENID) hasOwnConflict = true
        }
      }

      if (hasOwnConflict) {
        return { code: -1, message: '您在该时段已有预约' }
      }
      if (conflictCount >= techCount) {
        return { code: -1, message: '该时段已约满，请选择其他时段' }
      }

      const appointmentId = `apt_${crypto.randomBytes(14).toString('hex')}`
      const verifyCode = generateUniqueVerifyCode(allAppointments)
      const qrScene = createQrScene(appointmentId)
      await commitAppointment(date, bookingLock, appointmentId, {
        patient_openid: OPENID,
        services: serviceIds,
        total_duration: authoritativeDuration,
        technician_id: '',
        date,
        start_time,
        end_time: authoritativeEndTime,
        status: 'pending',
        verify_code: verifyCode,
        qr_scene: qrScene,
        ...(requestId ? {
          request_id: requestId,
          request_fingerprint: requestFingerprint
        } : {}),
        verified_at: '',
        cancel_reason: '',
        created_at: db.serverDate(),
        updated_at: db.serverDate()
      }, user._id, requestId, requestFingerprint)
      booking = { appointmentId, qrScene }
      committed = true
    } finally {
      if (!committed) await releaseBookingLock(date, bookingLock)
    }

    let qrCode = ''
    try {
      qrCode = await createAppointmentQrCode(booking.appointmentId, booking.qrScene)

      // 更新预约记录
      if (qrCode) {
        await db.collection('appointments')
          .doc(booking.appointmentId)
          .update({
            data: { qr_code: qrCode }
          })
      }
    } catch (qrErr) {
      console.error('生成二维码失败:', qrErr)
    }

    const bookingResult = {
      _id: booking.appointmentId,
      qr_code: qrCode
    }
    await completeBookingAttempt(user._id, requestId, requestFingerprint, bookingResult)
      .catch(err => console.error('记录预约幂等结果失败:', err))

    try {
      if (APPOINTMENT_CREATED_TEMPLATE_ID) {
        await cloud.openapi.subscribeMessage.send({
          touser: OPENID,
          templateId: APPOINTMENT_CREATED_TEMPLATE_ID,
          data: {
            thing1: { value: '预约成功' },
            time2: { value: `${date} ${start_time}` },
            thing3: { value: '请按时到店' }
          },
          page: `/pages/appointment-detail/appointment-detail?id=${booking.appointmentId}`
        })
      } else {
        console.warn('未配置预约成功订阅消息模板，跳过通知')
      }
    } catch (notifyErr) {
      console.error('发送通知失败:', notifyErr)
    }

    return {
      code: 0,
      data: bookingResult
    }
  } catch (err) {
    console.error('创建预约失败:', err)
    if (err && err.code === 'BOOKING_BUSY') {
      return { code: -1, message: '当前预约请求较多，请稍后重试' }
    }
    return { code: -1, message: '创建预约失败，请稍后重试' }
  }
}

function generateUniqueVerifyCode(appointments) {
  const usedCodes = new Set()
  for (const appointment of appointments || []) {
    if (!appointment) continue
    if (isVerifyCode(appointment.verify_code)) usedCodes.add(appointment.verify_code)
    if (isVerifyCode(appointment.qr_scene)) usedCodes.add(appointment.qr_scene)
  }
  for (let i = 0; i < 16; i++) {
    const code = randomVerifyCode()
    if (!usedCodes.has(code)) return code
  }

  throw new Error('核销码生成失败，请重新提交')
}

function randomVerifyCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function isVerifyCode(value) {
  return /^\d{6}$/.test(String(value || ''))
}

function createQrScene(appointmentId) {
  return crypto.createHash('sha256').update(appointmentId).digest('hex').slice(0, 32)
}

function createRequestFingerprint(openid, serviceIds, date, startTime) {
  return crypto.createHash('sha256').update(JSON.stringify({
    openid,
    services: [...serviceIds].sort(),
    date,
    start_time: startTime
  })).digest('hex')
}

async function reserveBookingAttempt(userId, requestId, requestFingerprint, now) {
  return db.runTransaction(async transaction => {
    const ref = transaction.collection('users').doc(userId)
    const user = (await ref.get()).data
    if (!user) return { status: 'limited' }

    const sameRequestId = Boolean(requestId) && user.booking_last_request_id === requestId
    if (sameRequestId && user.booking_last_request_fingerprint !== requestFingerprint) {
      return { status: 'conflict' }
    }
    if (sameRequestId && user.booking_last_appointment_id) {
      if (now - Number(user.booking_last_replay_at || 0) < BOOKING_CREATE_COOLDOWN_MS) {
        return { status: 'limited' }
      }
      let qrCode = user.booking_last_qr_code || ''
      if (!qrCode) {
        const appointment = (await transaction.collection('appointments')
          .doc(user.booking_last_appointment_id)
          .get()).data
        if (appointment && appointment.request_id === requestId &&
            appointment.request_fingerprint === requestFingerprint) {
          qrCode = appointment.qr_code || ''
        }
      }
      await ref.update({ data: {
        booking_last_replay_at: now,
        ...(qrCode ? { booking_last_qr_code: qrCode } : {})
      } })
      return {
        status: 'cached',
        data: {
          _id: user.booking_last_appointment_id,
          qr_code: qrCode
        }
      }
    }
    if (now - Number(user.booking_last_attempt_at || 0) < BOOKING_CREATE_COOLDOWN_MS) {
      return { status: 'limited' }
    }

    await ref.update({ data: {
      booking_last_attempt_at: now,
      booking_last_request_id: requestId,
      booking_last_request_fingerprint: requestFingerprint,
      booking_last_appointment_id: '',
      booking_last_qr_code: '',
      booking_last_replay_at: 0
    } })
    return { status: 'reserved' }
  })
}

async function completeBookingAttempt(userId, requestId, requestFingerprint, result) {
  if (!requestId || !result || !result._id) return
  await db.runTransaction(async transaction => {
    const ref = transaction.collection('users').doc(userId)
    const user = (await ref.get()).data
    if (!user || user.booking_last_request_id !== requestId ||
      user.booking_last_request_fingerprint !== requestFingerprint) return
    await ref.update({ data: {
      booking_last_appointment_id: result._id,
      booking_last_qr_code: result.qr_code || ''
    } })
  })
}

async function createAppointmentQrCode(appointmentId, qrScene) {
  const result = await cloud.openapi.wxacode.getUnlimited({
    scene: qrScene,
    page: 'pages/tech-home/tech-home',
    checkPath: false,
    envVersion: process.env.WECHAT_MINIPROGRAM_QR_ENV_VERSION || 'release',
    width: 280
  })
  if (!result || !result.buffer) {
    throw new Error('二维码生成失败')
  }
  const uploadRes = await cloud.uploadFile({
    cloudPath: `qrcodes/${appointmentId}-${qrScene}.jpg`,
    fileContent: result.buffer
  })
  return uploadRes.fileID || ''
}

// 时间字符串转分钟数
function timeToMinutes(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) return null
  const [hours, minutes] = timeStr.split(':').map(Number)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

function minutesToTime(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return ''
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function countActiveTechnicianDaysOff(daysOffRecords, activeTechnicianIds) {
  return (daysOffRecords || []).filter(record =>
    record && activeTechnicianIds.has(record.technician_id)
  ).length
}

function parseYmdToDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const [year, month, day] = dateStr.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null
  return parsed
}

function formatDateBj(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

async function acquireBookingLock(date) {
  const lockId = `booking_lock_${date}`
  const owner = crypto.randomBytes(16).toString('hex')
  await ensureBookingLockDocument(lockId)

  for (let attempt = 0; attempt < BOOKING_LOCK_RETRY_COUNT; attempt++) {
    try {
      const lock = await db.runTransaction(async transaction => {
        const lockRef = transaction.collection('login_sessions').doc(lockId)
        const lockRes = await lockRef.get()
        const current = lockRes.data || {}
        const now = Date.now()
        if (current.owner && Number(current.expires_at || 0) > now) {
          return { acquired: false }
        }

        const next = {
          acquired: true,
          owner,
          fence: Number(current.fence || 0) + 1,
          expires_at: now + BOOKING_LOCK_TTL_MS
        }
        await lockRef.update({
          data: {
            type: 'booking_capacity_lock',
            status: 'locked',
            owner: next.owner,
            fence: next.fence,
            expires_at: next.expires_at,
            updated_at: now
          }
        })
        return next
      })
      if (lock && lock.acquired) return lock
    } catch (err) {
      console.error('预约锁事务重试:', err)
    }
    await new Promise(resolve => setTimeout(resolve, 60 + attempt * 25))
  }

  throw createBookingBusyError()
}

async function ensureBookingLockDocument(lockId) {
  try {
    await db.collection('login_sessions').add({
      data: {
        _id: lockId,
        type: 'booking_capacity_lock',
        status: 'released',
        owner: '',
        fence: 0,
        expires_at: 0,
        updated_at: Date.now()
      }
    })
  } catch (err) {
    try {
      const existing = await db.collection('login_sessions').doc(lockId).get()
      if (existing.data && existing.data.type === 'booking_capacity_lock') return
    } catch (readErr) {
      console.error('读取预约锁失败:', readErr)
    }
    throw err
  }
}

async function getAllAppointmentsByDate(date) {
  const appointments = []
  const pageSize = 100
  for (let skip = 0; ; skip += pageSize) {
    const res = await db.collection('appointments')
      .where({ date })
      .skip(skip)
      .limit(pageSize)
      .get()
    const page = res.data || []
    appointments.push(...page)
    if (page.length < pageSize) return appointments
  }
}

async function commitAppointment(date, lock, appointmentId, appointment, userId, requestId, requestFingerprint) {
  const lockId = `booking_lock_${date}`
  return db.runTransaction(async transaction => {
    const lockRef = transaction.collection('login_sessions').doc(lockId)
    const lockRes = await lockRef.get()
    const current = lockRes.data || {}
    if (current.owner !== lock.owner || Number(current.fence) !== lock.fence || Number(current.expires_at) <= Date.now()) {
      throw createBookingBusyError()
    }

    let userRef
    if (requestId) {
      userRef = transaction.collection('users').doc(userId)
      const attemptUser = (await userRef.get()).data
      if (!attemptUser || attemptUser.booking_last_request_id !== requestId ||
          attemptUser.booking_last_request_fingerprint !== requestFingerprint) {
        throw createBookingBusyError()
      }
    }

    await transaction.collection('appointments').doc(appointmentId).set({ data: appointment })
    if (userRef) {
      await userRef.update({ data: {
        booking_last_appointment_id: appointmentId,
        booking_last_qr_code: '',
        booking_last_replay_at: 0
      } })
    }
    await lockRef.update({
      data: {
        status: 'released',
        owner: '',
        fence: lock.fence,
        expires_at: 0,
        updated_at: Date.now()
      }
    })
  })
}

async function releaseBookingLock(date, lock) {
  if (!date || !lock) return
  try {
    await db.runTransaction(async transaction => {
      const lockRef = transaction.collection('login_sessions').doc(`booking_lock_${date}`)
      const lockRes = await lockRef.get()
      const current = lockRes.data || {}
      if (current.owner !== lock.owner || Number(current.fence) !== lock.fence) return
      await lockRef.update({
        data: {
          status: 'released',
          owner: '',
          fence: lock.fence,
          expires_at: 0,
          updated_at: Date.now()
        }
      })
    })
  } catch (err) {
    console.error('释放预约锁失败:', err)
  }
}

function createBookingBusyError() {
  const err = new Error('BOOKING_BUSY')
  err.code = 'BOOKING_BUSY'
  return err
}
