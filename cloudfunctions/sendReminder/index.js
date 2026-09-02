const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const APPOINTMENT_REMINDER_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_REMINDER || ''
const REMINDER_LEASE_MS = 5 * 60 * 1000
const REMINDER_FINALIZE_RETRY_COUNT = 3
const CLIENT_CALL_SOURCES = new Set(['wx_client', 'wx_devtools', 'wx_http'])

// 定时触发器：每分钟执行一次
exports.main = async (event, context) => {
  const { SOURCE } = cloud.getWXContext()
  if (CLIENT_CALL_SOURCES.has(SOURCE) || event?.Type !== 'Timer' || event.TriggerName !== 'reminderTrigger') {
    return { code: -1, message: '仅允许预约提醒定时触发器调用' }
  }

  try {
    // 获取当前时间（北京时间 UTC+8）
    const now = new Date()
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const today = formatDateBj(bjNow)
    const currentMinutes = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()

    // 获取1小时后的时间
    let reminderMinutes = currentMinutes + 60
    let reminderDate = today
    if (reminderMinutes >= 1440) {
      // 跨天：提醒时间在次日
      reminderMinutes -= 1440
      const nextDay = new Date(bjNow.getTime() + 24 * 60 * 60 * 1000)
      reminderDate = formatDateBj(nextDay)
    }
    const reminderTime = minutesToTime(reminderMinutes)

    // 查询待核销的预约
    const appointments = await db.collection('appointments')
      .where({
        date: reminderDate,
        status: 'pending',
        start_time: reminderTime
      })
      .get()

    // 发送提醒通知
    if (!APPOINTMENT_REMINDER_TEMPLATE_ID) {
      console.warn('未配置预约提醒订阅消息模板，跳过提醒通知')
      return { code: 0, data: { count: 0, skipped: appointments.data.length } }
    }

    let count = 0
    for (const apt of appointments.data) {
      const reminderKey = `appointment-reminder:${apt._id}:${reminderDate}:${reminderTime}`
      const claimToken = `${Date.now()}-${Math.random()}`
      let claimed = false
      let sent = false

      try {
        claimed = await claimReminder(apt._id, reminderDate, reminderTime, reminderKey, claimToken)
        if (!claimed) continue

        await cloud.openapi.subscribeMessage.send({
          touser: apt.patient_openid,
          templateId: APPOINTMENT_REMINDER_TEMPLATE_ID,
          data: {
            thing1: { value: '预约提醒' },
            time2: { value: `${apt.date} ${apt.start_time}` },
            thing3: { value: '您的预约即将开始，请准时到店' }
          },
          page: `/pages/appointment-detail/appointment-detail?id=${apt._id}`
        })
        sent = true
        let finalized = false
        for (let attempt = 0; attempt < REMINDER_FINALIZE_RETRY_COUNT && !finalized; attempt++) {
          try {
            finalized = await finalizeReminder(apt._id, reminderKey, claimToken)
          } catch (finalizeErr) {
            if (attempt === REMINDER_FINALIZE_RETRY_COUNT - 1) {
              console.error(`确认提醒发送状态失败: ${apt._id}`, normalizeReminderErrorCode(finalizeErr))
            }
          }
        }
        if (finalized) {
          count += 1
        } else {
          let uncertainRecorded = false
          for (let attempt = 0; attempt < REMINDER_FINALIZE_RETRY_COUNT && !uncertainRecorded; attempt++) {
            try {
              uncertainRecorded = await recordReminderDeliveryUncertain(apt._id, reminderKey, claimToken)
            } catch (uncertainErr) {
              if (attempt === REMINDER_FINALIZE_RETRY_COUNT - 1) {
                console.error(`记录提醒待确认状态失败: ${apt._id}`, normalizeReminderErrorCode(uncertainErr))
              }
            }
          }
        }
      } catch (err) {
        console.error(`发送提醒失败: ${apt._id}`, err)
        if (claimed && !sent) {
          const errorCode = normalizeReminderErrorCode(err)
          await recordReminderFailure(apt._id, reminderKey, claimToken, errorCode)
            .catch(async recordErr => {
              console.error(`记录提醒失败状态失败: ${apt._id}`, recordErr)
              await releaseReminderClaim(apt._id, reminderKey, claimToken)
                .catch(releaseErr => console.error(`释放提醒租约失败: ${apt._id}`, releaseErr))
            })
        }
      }
    }

    return { code: 0, data: { count } }
  } catch (err) {
    console.error('定时提醒执行失败:', err)
    return { code: -1, message: '发送提醒失败，请稍后重试' }
  }
}

async function claimReminder(id, date, startTime, reminderKey, claimToken) {
  return db.runTransaction(async transaction => {
    const ref = transaction.collection('appointments').doc(id)
    const appointment = (await ref.get()).data
    const now = Date.now()
    if (!appointment || appointment.status !== 'pending' || appointment.date !== date ||
      appointment.start_time !== startTime || appointment.reminder_sent_key === reminderKey ||
      appointment.reminder_delivery_uncertain_key === reminderKey ||
      appointment.reminder_claim_key === reminderKey ||
      Number(appointment.reminder_lease_until) > now) return false

    await ref.update({ data: {
      reminder_claim_token: claimToken,
      reminder_claim_key: reminderKey,
      reminder_lease_until: now + REMINDER_LEASE_MS,
      reminder_claimed_at: now
    } })
    return true
  })
}

async function finalizeReminder(id, reminderKey, claimToken) {
  return db.runTransaction(async transaction => {
    const ref = transaction.collection('appointments').doc(id)
    const appointment = (await ref.get()).data
    if (!appointment || appointment.reminder_claim_token !== claimToken ||
      appointment.reminder_claim_key !== reminderKey) return false

    await ref.update({ data: {
      reminder_sent_key: reminderKey,
      reminder_sent_at: db.serverDate(),
      reminder_failure_count: _.remove(),
      reminder_last_failed_at: _.remove(),
      reminder_last_error_code: _.remove(),
      reminder_delivery_uncertain_key: _.remove(),
      reminder_delivery_uncertain_at: _.remove(),
      reminder_claim_token: _.remove(),
      reminder_claim_key: _.remove(),
      reminder_lease_until: _.remove(),
      reminder_claimed_at: _.remove()
    } })
    return true
  })
}

async function recordReminderDeliveryUncertain(id, reminderKey, claimToken) {
  return db.runTransaction(async transaction => {
    const ref = transaction.collection('appointments').doc(id)
    const appointment = (await ref.get()).data
    if (!appointment || appointment.reminder_claim_token !== claimToken ||
      appointment.reminder_claim_key !== reminderKey) return false

    await ref.update({ data: {
      reminder_delivery_uncertain_key: reminderKey,
      reminder_delivery_uncertain_at: db.serverDate(),
      reminder_failure_count: _.remove(),
      reminder_last_failed_at: _.remove(),
      reminder_last_error_code: _.remove(),
      reminder_claim_token: _.remove(),
      reminder_claim_key: _.remove(),
      reminder_lease_until: _.remove(),
      reminder_claimed_at: _.remove()
    } })
    return true
  })
}

async function recordReminderFailure(id, reminderKey, claimToken, errorCode) {
  return db.runTransaction(async transaction => {
    const ref = transaction.collection('appointments').doc(id)
    const appointment = (await ref.get()).data
    if (!appointment || appointment.reminder_claim_token !== claimToken ||
      appointment.reminder_claim_key !== reminderKey) return false

    await ref.update({ data: {
      reminder_failure_count: Number(appointment.reminder_failure_count || 0) + 1,
      reminder_last_failed_at: db.serverDate(),
      reminder_last_error_code: errorCode,
      reminder_delivery_uncertain_key: _.remove(),
      reminder_delivery_uncertain_at: _.remove(),
      reminder_claim_token: _.remove(),
      reminder_claim_key: _.remove(),
      reminder_lease_until: _.remove(),
      reminder_claimed_at: _.remove()
    } })
    return true
  })
}

async function releaseReminderClaim(id, reminderKey, claimToken) {
  return db.runTransaction(async transaction => {
    const ref = transaction.collection('appointments').doc(id)
    const appointment = (await ref.get()).data
    if (!appointment || appointment.reminder_claim_token !== claimToken ||
      appointment.reminder_claim_key !== reminderKey) return

    await ref.update({ data: {
      reminder_claim_token: _.remove(),
      reminder_claim_key: _.remove(),
      reminder_lease_until: _.remove(),
      reminder_claimed_at: _.remove()
    } })
  })
}

function formatDateBj(bjDate) {
  const year = bjDate.getUTCFullYear()
  const month = String(bjDate.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bjDate.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeReminderErrorCode(error) {
  const value = String(error && (error.errCode || error.errcode || error.code) || '').trim()
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : 'SEND_FAILED'
}

function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60) % 24
  const mins = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}
