const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('staff appointment access is limited to today and a response allowlist', () => {
  const source = read('cloudfunctions/getAppointments/index.js')

  assert.match(source, /const \{ status \} = event/)
  assert.match(source, /date: getBeijingDate\(\)/)
  assert.match(source, /status: status \|\| _\.in\(WORK_STATUSES\)/)
  assert.match(source, /async function getTodayAppointments/)
  assert.match(source, /\.skip\(skip\)[\s\S]*\.limit\(pageSize\)/)
  assert.doesNotMatch(source, /return \{[\s\S]{0,120}\.\.\.apt/)
  for (const field of ['_id', 'service_names', 'status', 'start_time', 'end_time', 'patient_name', 'verified_at']) {
    assert.match(source, new RegExp(`\\b${field}:`))
  }
})

test('appointment creation uses a fenced lease, full pagination and a separate QR scene', () => {
  const source = read('cloudfunctions/createAppointment/index.js')

  assert.match(source, /BOOKING_LOCK_TTL_MS = 30000/)
  assert.match(source, /ensureBookingLockDocument\(lockId\)/)
  assert.match(source, /fence: Number\(current\.fence \|\| 0\) \+ 1/)
  assert.match(source, /current\.owner !== lock\.owner/)
  assert.match(source, /Number\(current\.fence\) !== lock\.fence/)
  assert.match(source, /Number\(current\.expires_at\) <= Date\.now\(\)/)
  assert.match(source, /transaction\.collection\('appointments'\)\.doc\(appointmentId\)\.set/)
  assert.match(source, /async function getAllAppointmentsByDate/)
  assert.match(source, /\.skip\(skip\)[\s\S]*\.limit\(pageSize\)/)
  assert.doesNotMatch(source, /\.limit\(1000\)/)
  assert.match(source, /generateUniqueVerifyCode\(allAppointments\)/)
  assert.match(source, /isVerifyCode\(appointment\.qr_scene\)/)
  assert.match(source, /createHash\('sha256'\)[\s\S]{0,100}slice\(0, 32\)/)
  assert.match(source, /verify_code: verifyCode,[\s\S]{0,80}qr_scene: qrScene/)
  assert.doesNotMatch(source, /qr_scene: verifyCode/)
  assert.match(source, /request_id: requestId/)
  assert.match(source, /request_fingerprint: requestFingerprint/)
  assert.match(source, /appointment\.request_id === requestId/)
})

test('verification is today-only and commits commissions atomically', () => {
  const source = read('cloudfunctions/verifyAppointment/index.js')
  const transactionAt = source.indexOf('completeAppointmentWithCommissions')
  const notificationAt = source.indexOf('cloud.openapi.subscribeMessage.send')

  assert.match(source, /date: today,[\s\S]{0,60}status: 'pending'/)
  assert.match(source, /\.limit\(2\)/)
  assert.match(source, /new Map\(\[\.\.\.byCode, \.\.\.legacyScene\]/)
  assert.match(source, /appointment\.date !== transactionToday \|\| appointment\.status !== 'pending'/)
  assert.match(source, /const currentMinutes = [^\n]+/)
  assert.match(source, /timeToMinutes\(appointment\.start_time\)/)
  assert.match(source, /currentMinutes < startMinutes/)
  assert.match(source, /预约尚未开始，暂不可核销/)
  assert.match(source, /db\.runTransaction\(async transaction =>/)
  assert.match(source, /transaction\.collection\('technicians'\)\.doc\(technicianId\)\.get\(\)/)
  assert.match(source, /technician\.openid !== openid \|\| technician\.status !== 'active'/)
  assert.match(source, /transaction\.collection\('services'\)\.doc\(serviceId\)\.get\(\)/)
  assert.match(source, /transaction\.collection\('commission_records'\)\.doc\(commissionId\)\.set/)
  assert.match(source, /createHash\('sha256'\)[\s\S]{0,120}appointmentId[\s\S]{0,80}serviceId/)
  assert.match(source, /await appointmentRef\.update/)
  assert.doesNotMatch(source, /collection\('commission_records'\)\.add\(/)
  assert.ok(source.indexOf('currentMinutes < startMinutes') < source.indexOf("transaction.collection('commission_records')"))
  assert.ok(transactionAt >= 0 && notificationAt > transactionAt, 'notification must run after the atomic completion')
})

test('appointment reminders require the timer trigger and use a persistent lease', () => {
  const source = read('cloudfunctions/sendReminder/index.js')
  const claimAt = source.indexOf('await claimReminder(')
  const sendAt = source.indexOf('cloud.openapi.subscribeMessage.send')
  const finalizeAt = source.indexOf('await finalizeReminder(')

  assert.match(source, /CLIENT_CALL_SOURCES = new Set\(\['wx_client', 'wx_devtools', 'wx_http'\]\)/)
  assert.match(source, /CLIENT_CALL_SOURCES\.has\(SOURCE\) \|\| event\?\.Type !== 'Timer' \|\| event\.TriggerName !== 'reminderTrigger'/)
  assert.match(source, /date: reminderDate,[\s\S]{0,100}status: 'pending',[\s\S]{0,100}start_time: reminderTime/)
  assert.match(source, /REMINDER_LEASE_MS = 5 \* 60 \* 1000/)
  assert.match(source, /db\.runTransaction\(async transaction =>/)
  assert.match(source, /reminder_sent_key === reminderKey/)
  assert.match(source, /Number\(appointment\.reminder_lease_until\) > now/)
  assert.match(source, /reminder_claim_token: claimToken/)
  assert.match(source, /reminder_sent_key: reminderKey/)
  assert.match(source, /await releaseReminderClaim\(apt\._id, reminderKey, claimToken\)/)
  assert.ok(claimAt >= 0 && sendAt > claimAt && finalizeAt > sendAt)
})

test('QR regeneration and ownership checks keep scene separate from the manual code', () => {
  const mine = read('cloudfunctions/getMyAppointments/index.js')
  const admin = read('cloudfunctions/admin/index.js')

  assert.match(mine, /const qrScene = isQrScene\(appointment\.qr_scene\) \|\| isVerifyCode\(appointment\.qr_scene\)/)
  assert.match(mine, /qr_scene: qrScene/)
  assert.match(mine, /createQrCode\(appointment\._id, qrScene\)/)
  assert.match(admin, /appointment\.qr_scene === scene/)
  assert.match(admin, /appointment\.patient_openid !== OPENID/)
})

test('availability uses authoritative service duration, fails closed and paginates', () => {
  const slots = read('cloudfunctions/getAvailableSlots/index.js')
  const availability = read('cloudfunctions/checkAvailability/index.js')
  const booking = read('miniprogram/pages/booking/booking.js')

  assert.match(slots, /const \{ date, serviceIds \} = event/)
  assert.match(availability, /const \{ serviceIds \} = event/)
  for (const source of [slots, availability]) {
    assert.match(source, /getAuthoritativeDuration\(serviceIds\)/)
    assert.match(source, /\.skip\(skip\)\.limit\(pageSize\)/)
    assert.match(source, /console\.error\(`\$\{label\} 查询失败:`[\s\S]{0,80}throw err/)
    assert.doesNotMatch(source, /console\.error\(`\$\{label\} 查询失败:`[\s\S]{0,80}return null/)
  }
  assert.match(booking, /verifyDateAvailability\(\)[\s\S]*serviceIds: this\.data\.selectedServices\.map/)
  assert.match(booking, /serviceIds: this\.data\.selectedServices\.map[\s\S]{0,120}totalDuration: this\.data\.totalDuration/)
  assert.match(booking, /request_id: this\._bookingRequestId/)
  assert.match(booking, /createBookingRequestId\(\)/)
})

test('cancellation rejects appointments that have started or expired', () => {
  const source = read('cloudfunctions/cancelAppointment/index.js')

  assert.match(source, /appointment\.date < today/)
  assert.match(source, /appointment\.date === today && startMinutes <=/)
  assert.match(source, /status: 'pending'/)
  assert.match(source, /已开始或已过期的预约无法取消/)
})
