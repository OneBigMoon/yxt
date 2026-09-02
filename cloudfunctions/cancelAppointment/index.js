const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const APPOINTMENT_CANCELLED_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_CANCELLED || ''

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { id } = event

  try {
    if (!OPENID) {
      return { code: -1, message: '登录状态异常，请重新登录' }
    }

    // 参数校验
    if (!id) {
      return { code: -1, message: '缺少预约ID' }
    }

    // 查询预约
    const aptRes = await db.collection('appointments')
      .doc(id)
      .get()

    if (!aptRes.data) {
      return { code: -1, message: '预约不存在' }
    }

    const appointment = aptRes.data

    // 验证是否是本人的预约
    if (appointment.patient_openid !== OPENID) {
      return { code: -1, message: '无权操作此预约' }
    }

    // 验证预约状态
    if (appointment.status !== 'pending') {
      return { code: -1, message: '该预约无法取消' }
    }

    const now = new Date()
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const today = formatDateBj(bjNow)
    const startMinutes = timeToMinutes(appointment.start_time)
    if (!parseYmdToDate(appointment.date) || startMinutes === null ||
        appointment.date < today ||
        (appointment.date === today && startMinutes <= bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes())) {
      return { code: -1, message: '已开始或已过期的预约无法取消' }
    }

    // 取消预约
    const updateRes = await db.collection('appointments')
      .where({
        _id: id,
        patient_openid: OPENID,
        status: 'pending'
      })
      .update({
        data: {
          status: 'cancelled',
          updated_at: db.serverDate()
        }
      })
    const updated = Number(updateRes && ((updateRes.stats && updateRes.stats.updated) || updateRes.updated || 0))
    if (updated === 0) {
      return { code: -1, message: '预约状态已变化，请刷新后重试' }
    }

    // 发送取消通知
    try {
      if (APPOINTMENT_CANCELLED_TEMPLATE_ID) {
        await cloud.openapi.subscribeMessage.send({
          touser: OPENID,
          templateId: APPOINTMENT_CANCELLED_TEMPLATE_ID,
          data: {
            thing1: { value: '预约取消' },
            time2: { value: `${appointment.date} ${appointment.start_time}` },
            thing3: { value: '已取消预约' }
          }
        })
      } else {
        console.warn('未配置预约取消订阅消息模板，跳过通知')
      }
    } catch (notifyErr) {
      console.error('发送通知失败:', notifyErr)
    }

    return { code: 0, data: { message: '取消成功' } }
  } catch (err) {
    console.error('取消预约失败:', err)
    return { code: -1, message: '取消预约失败，请稍后重试' }
  }
}

function timeToMinutes(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) return null
  const [hours, minutes] = timeStr.split(':').map(Number)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
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
