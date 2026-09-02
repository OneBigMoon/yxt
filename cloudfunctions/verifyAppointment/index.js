const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const APPOINTMENT_VERIFIED_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_VERIFIED || ''

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { id } = event
  const verifyValue = String(id || '').trim()

  try {
    if (!OPENID) {
      return { code: -1, message: '登录状态异常，请重新登录' }
    }

    // 参数校验
    if (!verifyValue) {
      return { code: -1, message: '缺少核销码' }
    }

    // 验证是否是顾问
    const techRes = await db.collection('technicians')
      .where({
        openid: OPENID,
        status: 'active'
      })
      .limit(1)
      .get()

    if (techRes.data.length === 0) {
      return { code: -1, message: '无权操作，仅顾问可核销' }
    }

    const technician = techRes.data[0]

    const today = formatBeijingDate(new Date())
    // 手输码、二维码 scene 与预约记录入口均由服务端限制为当天待核销预约。
    const lookup = await findAppointmentForVerify(verifyValue, today)
    if (lookup && lookup.ambiguous) {
      return { code: -1, message: '核销信息存在冲突，请改用预约记录核销' }
    }
    if (!lookup) {
      return { code: -1, message: isVerifyCode(verifyValue) ? '核销码无效' : '预约不存在' }
    }

    const completed = await completeAppointmentWithCommissions(lookup.appointmentId, technician._id, OPENID)
    if (!completed.ok) return { code: -1, message: completed.message }
    const appointment = completed.appointment

    // 发送核销完成通知
    try {
      if (APPOINTMENT_VERIFIED_TEMPLATE_ID) {
        await cloud.openapi.subscribeMessage.send({
          touser: appointment.patient_openid,
          templateId: APPOINTMENT_VERIFIED_TEMPLATE_ID,
          data: {
            thing1: { value: '核销完成' },
            time2: { value: formatDateTime(new Date()) },
            thing3: { value: '感谢您的光临' }
          }
        })
      } else {
        console.warn('未配置核销完成订阅消息模板，跳过通知')
      }
    } catch (notifyErr) {
      console.error('发送通知失败:', notifyErr)
    }

    return { code: 0, data: { message: '核销成功' } }
  } catch (err) {
    console.error('核销预约失败:', err)
    if (err && err.code === 'VERIFICATION_DATA_INVALID') {
      return { code: -1, message: '预约服务配置异常，请联系门店处理' }
    }
    return { code: -1, message: '核销预约失败，请稍后重试' }
  }
};

async function findAppointmentForVerify(value, today) {
  if (isVerifyCode(value)) {
    const [byCode, legacyScene] = await Promise.all([
      findPendingCandidatesBy('verify_code', value, today),
      findPendingCandidatesBy('qr_scene', value, today)
    ])
    const candidates = new Map([...byCode, ...legacyScene].map(appointment => [appointment._id, appointment]))
    if (candidates.size > 1) return { ambiguous: true }
    if (candidates.size === 1) return { appointmentId: candidates.keys().next().value }
  } else if (isQrScene(value)) {
    const byScene = await findPendingCandidatesBy('qr_scene', value, today)
    if (byScene.length > 1) return { ambiguous: true }
    if (byScene.length === 1) return { appointmentId: byScene[0]._id }
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return null
  try {
    const aptRes = await db.collection('appointments').doc(value).get()
    if (aptRes.data) {
      return {
        appointment: aptRes.data,
        appointmentId: value
      }
    }
  } catch (err) {
    return null
  }

  return null
}

async function findPendingCandidatesBy(field, value, today) {
  const res = await db.collection('appointments')
    .where({
      [field]: value,
      date: today,
      status: 'pending'
    })
    .limit(2)
    .get()
  return res.data || []
}

function isVerifyCode(value) {
  return /^\d{6}$/.test(String(value || ''))
}

function isQrScene(value) {
  return /^[a-f0-9]{32}$/.test(String(value || ''))
}

async function completeAppointmentWithCommissions(appointmentId, technicianId, openid) {
  return db.runTransaction(async transaction => {
    const appointmentRef = transaction.collection('appointments').doc(appointmentId)
    const appointmentRes = await appointmentRef.get()
    const appointment = appointmentRes.data
    if (!appointment) return { ok: false, message: '预约不存在' }

    const technicianRes = await transaction.collection('technicians').doc(technicianId).get()
    const technician = technicianRes.data
    if (!technician || technician.openid !== openid || technician.status !== 'active') {
      return { ok: false, message: '无权操作，仅顾问可核销' }
    }

    const transactionToday = formatBeijingDate(new Date())
    if (appointment.date !== transactionToday || appointment.status !== 'pending') {
      return { ok: false, message: '仅可核销当天待处理预约' }
    }

    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const currentMinutes = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()
    const startMinutes = timeToMinutes(appointment.start_time)
    if (startMinutes === null) throw createVerificationDataError()
    if (currentMinutes < startMinutes) {
      return { ok: false, message: '预约尚未开始，暂不可核销' }
    }

    const serviceIds = [...new Set((appointment.services || []).map(id => String(id || '').trim()).filter(Boolean))]
    if (serviceIds.length === 0 || serviceIds.length > 10 || serviceIds.length !== (appointment.services || []).length) {
      throw createVerificationDataError()
    }

    const services = []
    for (const serviceId of serviceIds) {
      try {
        const serviceRes = await transaction.collection('services').doc(serviceId).get()
        if (!serviceRes.data) throw createVerificationDataError()
        services.push(serviceRes.data)
      } catch (err) {
        if (err && err.code === 'VERIFICATION_DATA_INVALID') throw err
        throw createVerificationDataError()
      }
    }

    for (const service of services) {
      const customCommissions = technician.custom_commissions || {}
      const hasCustomCommission = Object.prototype.hasOwnProperty.call(customCommissions, service._id)
      const commissionAmount = Number(hasCustomCommission ? customCommissions[service._id] : (service.default_commission || 0))
      if (!Number.isFinite(commissionAmount) || commissionAmount < 0) throw createVerificationDataError()

      const commissionId = createCommissionId(appointmentId, service._id)
      await transaction.collection('commission_records').doc(commissionId).set({
        data: {
          technician_id: technician._id,
          technician_name: technician.name,
          appointment_id: appointmentId,
          service_id: service._id,
          service_name: service.name,
          service_price: service.price,
          commission_amount: commissionAmount,
          commission_type: hasCustomCommission ? 'custom' : 'default',
          date: appointment.date,
          created_at: db.serverDate()
        }
      })
    }

    await appointmentRef.update({
      data: {
        status: 'completed',
        technician_id: technician._id,
        verified_at: db.serverDate(),
        updated_at: db.serverDate()
      }
    })
    return { ok: true, appointment: { ...appointment, _id: appointmentId } }
  })
}

function createCommissionId(appointmentId, serviceId) {
  return crypto.createHash('sha256').update(`${appointmentId}:${serviceId}`).digest('hex').slice(0, 32)
}

function createVerificationDataError() {
  const err = new Error('VERIFICATION_DATA_INVALID')
  err.code = 'VERIFICATION_DATA_INVALID'
  return err
}

function formatBeijingDate(date) {
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`
}

function timeToMinutes(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) return null
  const [hours, minutes] = timeStr.split(':').map(Number)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

function formatDateTime(date) {
  // 转换为北京时间 (UTC+8)
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = bj.getUTCFullYear()
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bj.getUTCDate()).padStart(2, '0')
  const hours = String(bj.getUTCHours()).padStart(2, '0')
  const minutes = String(bj.getUTCMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}
