const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

function section(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end))
}

test('scan login fails closed before creating cloud sessions', () => {
  const cloud = read('cloudfunctions/admin/index.js')
  const api = read('admin-web/src/api/index.js')
  const login = read('admin-web/src/views/Login.vue')
  const users = read('admin-web/src/views/AdminUsers.vue')
  const createLogin = section(cloud, 'async function createLoginSession', 'async function createAdminBindSession')
  const createBind = section(cloud, 'async function createAdminBindSession', 'async function createMiniProgramLoginQrCode')

  assert.match(cloud, /function isWechatQrConfigured\(\)[\s\S]{0,220}Boolean/)
  assert.match(cloud, /admin_login_capabilities:[\s\S]{0,160}scan_login_enabled: wechatQrConfigured[\s\S]{0,80}wechat_bind_enabled: wechatQrConfigured/)
  assert.match(createLogin, /SCAN_LOGIN_UNAVAILABLE/)
  assert.match(createBind, /SCAN_LOGIN_UNAVAILABLE/)
  assert.ok(createLogin.indexOf('SCAN_LOGIN_UNAVAILABLE') < createLogin.indexOf('cleanupExpiredLoginSessions()'))
  assert.ok(createBind.indexOf('SCAN_LOGIN_UNAVAILABLE') < createBind.indexOf('cleanupExpiredLoginSessions()'))
  assert.match(api, /SCAN_LOGIN_UNAVAILABLE: '扫码能力暂未配置，请使用账号密码登录'/)
  assert.match(login, /<el-tab-pane v-if="scanLoginEnabled" label="扫码登录"/)
  assert.match(login, /const config = await configApi\.get\(\)/)
  assert.match(users, /scanLoginEnabled\.value && hasActionPermission\('createAdminBindSession'\)/)
})

test('subscription authorization is optional and precedes booking writes', () => {
  const cloud = read('cloudfunctions/admin/index.js')
  const booking = read('miniprogram/pages/booking/booking.js')
  const publicConfig = section(cloud, 'async function getConfig()', 'async function getConfigDraft')
  const confirmBooking = section(booking, 'async confirmBooking()', '\n  createBookingRequestId() {')
  const goToAppointments = section(booking, 'async goToAppointments()', '\n  onSuccessClose() {')

  assert.match(publicConfig, /subscribe_templates:[\s\S]{0,500}SUBSCRIBE_TEMPLATE_APPOINTMENT_CREATED/)
  assert.match(publicConfig, /SUBSCRIBE_TEMPLATE_APPOINTMENT_VERIFIED/)
  assert.match(booking, /requestSubscribeMessages\(templateIds = \[\]\)/)
  assert.match(booking, /typeof wx\.requestSubscribeMessage !== 'function'/)
  assert.match(booking, /complete: \(\) => resolve\(\)/)
  assert.ok(confirmBooking.indexOf('await this.requestSubscribeMessages') >= 0)
  assert.ok(confirmBooking.indexOf('await this.requestSubscribeMessages') < confirmBooking.indexOf('await createAppointment'))
  assert.match(goToAppointments, /await this\.requestSubscribeMessages\(this\.data\.followupSubscribeTemplateIds\)/)
})

test('production monitor checks hosting, function health and hardened responses', () => {
  const workflow = read('.github/workflows/production-monitor.yml')

  assert.match(workflow, /ADMIN_ENTRY_URL:/)
  assert.match(workflow, /ADMIN_HEALTH_URL:[\s\S]{0,220}action=health/)
  assert.match(workflow, /jq --exit-status '\.status == "ok" and \.service == "admin"'/)
  assert.match(workflow, /\^cache-control: no-store/)
  assert.match(workflow, /\^x-content-type-options: nosniff/)
  assert.match(workflow, /\^x-frame-options: DENY/)
  assert.match(workflow, /force_failure/)
})
