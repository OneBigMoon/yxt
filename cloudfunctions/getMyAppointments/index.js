const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { status, id } = event

  try {
    if (!OPENID) {
      return { code: -1, message: '登录状态异常，请重新登录' }
    }

    let conditions = { patient_openid: OPENID }

    if (id) {
      conditions._id = id
    }

    if (status && !id) {
      conditions.status = status
    }

    let query = db.collection('appointments')
      .where(conditions)

    const res = await query
      .orderBy('created_at', 'desc')
      .get()

    // 获取服务名称和顾问名称
    const appointments = await Promise.all(res.data.map(async (apt) => {
      let appointment = apt
      if (id && apt.status === 'pending' && (!apt.verify_code || !apt.qr_code)) {
        appointment = await ensureVerificationPayload(apt)
      }

      // 获取服务名称
      let serviceNames = ''
      if (appointment.services && appointment.services.length > 0) {
        const servicesRes = await db.collection('services')
          .where({ _id: _.in(appointment.services) })
          .get()
        serviceNames = servicesRes.data.map(s => s.name).join('、')
      }

      // 获取顾问名称
      let technicianName = ''
      if (appointment.technician_id) {
        try {
          const techRes = await db.collection('technicians')
            .doc(appointment.technician_id)
            .get()
          if (techRes.data) {
            technicianName = techRes.data.name
          }
        } catch (e) {
          console.error('获取顾问信息失败:', e.message)
        }
      }

      return {
        _id: appointment._id,
        services: Array.isArray(appointment.services) ? appointment.services : [],
        date: appointment.date,
        start_time: appointment.start_time,
        end_time: appointment.end_time,
        total_duration: appointment.total_duration,
        status: appointment.status,
        technician_id: appointment.technician_id,
        verify_code: appointment.verify_code,
        qr_scene: appointment.qr_scene,
        qr_code: appointment.qr_code,
        verified_at: appointment.verified_at,
        service_names: serviceNames,
        technician_name: technicianName
      }
    }))

    return { code: 0, data: appointments }
  } catch (err) {
    console.error('获取预约列表失败:', err)
    return { code: -1, message: '获取我的预约失败，请稍后重试' }
  }
}

async function ensureVerificationPayload(appointment) {
  const verifyCode = isVerifyCode(appointment.verify_code)
    ? appointment.verify_code
    : await generateUniqueVerifyCode()
  const qrScene = isQrScene(appointment.qr_scene) || isVerifyCode(appointment.qr_scene)
    ? appointment.qr_scene
    : createQrScene(appointment._id)
  const data = {
    verify_code: verifyCode,
    qr_scene: qrScene
  }

  if (!appointment.qr_code) {
    try {
      data.qr_code = await createQrCode(appointment._id, qrScene)
    } catch (err) {
      console.error('补生成预约二维码失败:', err)
    }
  }

  await db.collection('appointments')
    .doc(appointment._id)
    .update({
      data: {
        ...data,
        updated_at: db.serverDate()
      }
    })

  return {
    ...appointment,
    ...data
  }
}

function createQrScene(appointmentId) {
  return crypto.createHash('sha256').update(String(appointmentId || '')).digest('hex').slice(0, 32)
}

async function createQrCode(appointmentId, qrScene) {
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

async function generateUniqueVerifyCode() {
  for (let i = 0; i < 8; i++) {
    const code = randomVerifyCode()
    const [codeRes, sceneRes] = await Promise.all([
      db.collection('appointments')
        .where({ verify_code: code, status: 'pending' })
        .limit(1)
        .get(),
      db.collection('appointments')
        .where({ qr_scene: code, status: 'pending' })
        .limit(1)
        .get()
    ])

    if ((!codeRes.data || codeRes.data.length === 0) &&
        (!sceneRes.data || sceneRes.data.length === 0)) {
      return code
    }
  }

  throw new Error('核销码生成失败，请稍后重试')
}

function randomVerifyCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function isVerifyCode(value) {
  return /^\d{6}$/.test(String(value || ''))
}

function isQrScene(value) {
  return /^[a-f0-9]{32}$/.test(String(value || ''))
}
