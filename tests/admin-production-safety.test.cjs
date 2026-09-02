const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/admin/index.js'), 'utf8')

function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end))
}

test('business config creation and version publishing are deterministic and atomic', () => {
  const singleton = section('async function getOrCreateBusinessConfigDocument', 'async function getConfig()')
  const versioning = section('async function createConfigVersion', 'async function publishConfig')

  assert.match(source, /const BUSINESS_CONFIG_PRIMARY_ID = 'primary'/)
  assert.match(singleton, /where\(\{ _id: BUSINESS_CONFIG_PRIMARY_ID \}\)\.limit\(1\)/)
  assert.match(singleton, /collection\.limit\(2\)\.get\(\)/)
  assert.match(singleton, /BUSINESS_CONFIG_DUPLICATE/)
  assert.match(singleton, /collection\.doc\(BUSINESS_CONFIG_PRIMARY_ID\)\.set/)

  assert.match(versioning, /db\.runTransaction\(async transaction/)
  assert.match(versioning, /currentVersion !== Number\(expectedState\.publishedVersion/)
  assert.match(versioning, /draft_updated_at[\s\S]*expectedState\.draftUpdatedAt/)
  assert.match(versioning, /transaction\.collection\('business_config_versions'\)\.doc\(versionId\)\.set/)
  assert.match(versioning, /await configRef\.update/)
  assert.match(versioning, /\.\.\.\(expectedState\.extraUpdates \|\| \{\}\)/)
})

test('production seed and customer deletion can resume safely after partial failure', () => {
  const seed = section('async function initializeProductionContent', 'async function verifyAdminPassword')
  const deletion = section('async function deleteCustomer', '// ==================== 预约管理')

  assert.match(seed, /where\(\{ seed_version: PRODUCTION_SEED_VERSION \}\)\.get\(\)/)
  assert.match(seed, /createDeterministicDocumentId\('seed_service'/)
  assert.match(seed, /createDeterministicDocumentId\('seed_article'/)
  assert.match(seed, /\.doc\(serviceId\)\.set/)
  assert.match(seed, /\.doc\(articleId\)\.set/)
  assert.match(seed, /extraUpdates:[\s\S]*production_seed_version: PRODUCTION_SEED_VERSION/)

  assert.match(deletion, /const openidHash = crypto\.createHash\('sha256'\)\.update\(openid\)\.digest\('hex'\)/)
  assert.match(deletion, /const anonymizedId = `deleted_\$\{openidHash\.slice\(0, 32\)\}`/)
  assert.doesNotMatch(deletion, /anonymizedId = `deleted_\$\{crypto\.randomBytes/)
})

test('calendar writes use stable ids and commission totals paginate all records', () => {
  const addHoliday = section('async function addHoliday', 'async function deleteHoliday')
  const addDayOff = section('async function addTechDayOff', 'async function deleteTechDayOff')
  const commission = section('async function getCommissionSummary', '// ==================== 文章管理')

  assert.match(addHoliday, /createDeterministicDocumentId\('holiday'/)
  assert.match(addHoliday, /collection\('holidays'\)\.doc\(holidayId\)\.set/)
  assert.match(addDayOff, /createDeterministicDocumentId\('tech_day_off'/)
  assert.match(addDayOff, /collection\('tech_days_off'\)\.doc\(dayOffId\)\.set/)
  assert.match(commission, /while \(true\)/)
  assert.match(commission, /\.skip\(skip\)\.limit\(COMMISSION_SUMMARY_PAGE_SIZE\)\.get\(\)/)
  assert.match(commission, /skip \+= records\.length/)
})

test('admin customer and appointment responses use explicit least-privilege fields', () => {
  const customers = section('async function getCustomers', 'async function updateCustomer')
  const appointments = section('async function getAdminAppointments', '// ==================== 休息管理')
  const detail = section('async function getAppointmentDetail', 'async function toggleBlacklist')
  const customerView = fs.readFileSync(path.resolve(__dirname, '../admin-web/src/views/Customers.vue'), 'utf8')

  assert.match(customers, /const canViewContact = adminAuth\.role === 'super_admin' \|\| adminAuth\.role === 'manager'/)
  assert.match(customers, /_id: item\._id[\s\S]*notes: canViewContact/)
  assert.doesNotMatch(customers, /list: res\.data/)
  assert.doesNotMatch(customers, /openid:/)

  assert.match(appointments, /params\.patient_user_id/)
  assert.match(appointments, /conditions\.patient_openid = patientOpenid/)
  assert.doesNotMatch(appointments, /return \{\s*\.\.\.apt/)
  const appointmentPayload = appointments.match(/return \{\s*_id: apt\._id[\s\S]*?patient_name: patientName\s*\}/)[0]
  const detailPayload = detail.slice(detail.indexOf('return buildSuccessResult'))
  for (const privateField of ['patient_openid', 'verify_code', 'qr_scene', 'request_id', 'request_fingerprint']) {
    assert.doesNotMatch(appointmentPayload, new RegExp(`\\b${privateField}:`))
    assert.doesNotMatch(detailPayload, new RegExp(`\\b${privateField}:`))
  }
  assert.match(detail, /patient_phone: adminAuth\.role === 'viewer' \? '' : patientPhone/)
  assert.match(customerView, /patient_openid: row\.openid \|\| '__no_patient_openid__'[\s\S]{0,80}patient_user_id: row\._id/)
})

test('anonymous scan login creation is caller-bound and audits only successful QR creation', () => {
  const scan = section('async function createLoginSession', 'async function createAdminBindSession')
  const qr = section('async function createMiniProgramLoginQrCode', 'async function createAppointmentQrCode')
  const qrAt = scan.indexOf('await createMiniProgramLoginQrCode(sessionId)')
  const auditAt = scan.indexOf("await writeAdminAuditLog({}, 'admin.scan_qr.create'")

  assert.match(source, /function createCallerBoundLoginSessionId\(context = \{\}\)[\s\S]{0,180}process\.env\.TCB_UUID[\s\S]{0,100}getCloudbaseUidFromContext\(context\)/)
  assert.doesNotMatch(source, /createCallerBoundLoginSessionId[\s\S]{0,300}TCB_SOURCE_IP/)
  assert.doesNotMatch(source, /context\.userInfo\.uid|context\.auth\.uid/)
  assert.match(scan, /const reservationId = normalizeMiniProgramScene\(createCallerBoundLoginSessionId\(context\)\)/)
  assert.match(scan, /const sessionId = generateSessionId\(\)/)
  assert.match(scan, /db\.runTransaction\(async transaction/)
  assert.match(scan, /transaction\.collection\('login_sessions'\)\.doc\(reservationId\)/)
  assert.match(scan, /getScanQrRetryAfter\(existingReservation, now\)/)
  assert.match(scan, /type: 'admin_login_rate_limit'/)
  assert.match(scan, /transaction\.collection\('login_sessions'\)\.doc\(sessionId\)/)
  assert.match(scan, /await sessionRef\.set/)
  assert.match(scan, /RATE_LIMITED/)
  assert.doesNotMatch(scan, /MAX_PENDING_LOGIN_SESSIONS|where\(\{ status: 'pending', type: 'admin_login' \}\)/)
  assert.match(qr, /cloud\.openapi\.wxacode\.getUnlimited\([\s\S]*envVersion: WECHAT_MINIPROGRAM_QR_ENV_VERSION/)
  assert.ok(qrAt >= 0 && auditAt > qrAt, 'successful audit must be written only after QR generation')
})
