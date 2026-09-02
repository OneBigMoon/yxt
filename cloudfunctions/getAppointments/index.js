const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const WORK_STATUSES = ['pending', 'completed']

function getBeijingDate() {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${bjNow.getUTCFullYear()}-${String(bjNow.getUTCMonth() + 1).padStart(2, '0')}-${String(bjNow.getUTCDate()).padStart(2, '0')}`
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { status } = event

  try {
    if (!OPENID) {
      return { code: -1, message: '登录状态异常，请重新登录' }
    }

    // 验证是否是顾问
    const techRes = await db.collection('technicians')
      .where({
        openid: OPENID,
        status: 'active'
      })
      .get()

    if (techRes.data.length === 0) {
      return { code: -1, message: '无权操作' }
    }

    if (status && !WORK_STATUSES.includes(status)) {
      return { code: -1, message: '无效状态' }
    }

    // 日期由服务端锁定为北京时间当天，避免客户端跨日读取。
    const todayAppointments = await getTodayAppointments(status)

    // 获取服务名称和客户信息
    const appointments = await Promise.all(todayAppointments.map(async (apt) => {
      // 获取服务名称
      let serviceNames = ''
      if (apt.services && apt.services.length > 0) {
        try {
          const servicesRes = await db.collection('services')
            .where({ _id: _.in(apt.services) })
            .get()
          serviceNames = servicesRes.data.map(s => s.name).join('、')
        } catch (e) {
          console.error('获取服务信息失败:', e.message)
        }
      }

      // 获取客户信息
      let patientName = '未知用户'
      try {
        const userRes = await db.collection('users')
          .where({ openid: apt.patient_openid })
          .get()
        if (userRes.data.length > 0) {
          patientName = userRes.data[0].nick_name || '未知用户'
        }
      } catch (e) {
        console.error('获取用户信息失败:', e.message)
      }

      return {
        _id: apt._id,
        service_names: serviceNames,
        status: apt.status,
        start_time: apt.start_time,
        end_time: apt.end_time,
        patient_name: patientName,
        verified_at: apt.verified_at
      }
    }))

    return { code: 0, data: appointments }
  } catch (err) {
    console.error('获取预约列表失败:', err)
    return { code: -1, message: '获取预约列表失败，请稍后重试' }
  }
}

async function getTodayAppointments(status) {
  const appointments = []
  const pageSize = 100
  for (let skip = 0; ; skip += pageSize) {
    const res = await db.collection('appointments')
      .where({
        date: getBeijingDate(),
        status: status || _.in(WORK_STATUSES)
      })
      .orderBy('start_time', 'asc')
      .skip(skip)
      .limit(pageSize)
      .get()
    const page = res.data || []
    appointments.push(...page)
    if (page.length < pageSize) return appointments
  }
}
