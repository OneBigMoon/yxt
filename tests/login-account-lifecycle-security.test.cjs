const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const loginSource = fs.readFileSync(path.join(root, 'cloudfunctions/login/index.js'), 'utf8')
const authSource = fs.readFileSync(path.join(root, 'miniprogram/utils/auth.js'), 'utf8')

test('self-service deletion is stable, retryable, and leaves a non-personal tombstone', () => {
  const start = loginSource.indexOf("if (type === 'deleteAccount')")
  const end = loginSource.indexOf("return { code: -1, message: '未知操作", start)
  const deletion = loginSource.slice(start, end)
  const anonymizeAt = deletion.indexOf('await anonymizeAppointments(OPENID, anonymizedId)')
  const deleteUsersAt = deletion.indexOf('await deleteUsersByOpenid(OPENID)')
  const tombstoneAt = deletion.indexOf("doc(tombstoneId).set({ data: tombstone })")
  const tombstone = deletion.match(/const tombstone = \{([\s\S]*?)\n\s*\}/)

  assert.match(deletion, /crypto\.createHash\('sha256'\)\.update\(OPENID\)\.digest\('hex'\)/)
  assert.doesNotMatch(deletion, /crypto\.randomBytes/)
  assert.doesNotMatch(deletion, /if \(userRes\.data\.length === 0\)[\s\S]{0,80}deleted: true/)
  assert.ok(tombstoneAt >= 0 && anonymizeAt > tombstoneAt && deleteUsersAt > anonymizeAt)
  assert.ok(tombstone)
  assert.match(tombstone[1], /status: 'deleted'/)
  assert.match(tombstone[1], /deleted_by_admin: false/)
  assert.doesNotMatch(tombstone[1], /openid|phone|nick_name|avatar_url/)
  assert.match(deletion, /identityUser[\s\S]*avatarFileId[\s\S]*cloud\.deleteFile\(\{ fileList: \[avatarFileId\] \}\)/)
})

test('deleted identities fail closed before role binding', () => {
  const deletedChecks = loginSource.match(/identityRecord\.status === 'deleted'/g) || []
  const finalDeletedCheckAt = loginSource.lastIndexOf("identityRecord.status === 'deleted'")
  const technicianLookupAt = loginSource.indexOf('technicianInfo = await findActiveTechnicianByPhone')

  assert.ok(deletedChecks.length >= 2, 'admin and self-service tombstones must both be rejected')
  assert.ok(finalDeletedCheckAt >= 0 && technicianLookupAt > finalDeletedCheckAt)
})

test('session-sync responses retain caller OpenID for legacy-client compatibility', async () => {
  const buildStart = loginSource.indexOf('function buildLoginData')
  const buildEnd = loginSource.indexOf('\nfunction userDocumentId', buildStart)
  const loginStart = loginSource.indexOf("if (type === 'login')")
  const refreshStart = loginSource.indexOf("if (type === 'refresh')")
  const refreshEnd = loginSource.indexOf("if (type === 'updateProfile')", refreshStart)
  const updateEnd = loginSource.indexOf("if (type === 'deleteAccount')", refreshEnd)
  const login = loginSource.slice(loginStart, refreshStart)
  const refresh = loginSource.slice(refreshStart, refreshEnd)
  const update = loginSource.slice(refreshEnd, updateEnd)
  const buildLoginData = new Function(
    'DEFAULT_NICK_NAME',
    `${loginSource.slice(buildStart, buildEnd)}\nreturn buildLoginData`
  )('微信用户')
  const data = buildLoginData('caller-openid', { nick_name: '用户', phone: '13800000000' }, 'patient', null, false)

  assert.equal(data.openid, 'caller-openid')
  assert.match(login, /data: buildLoginData\(OPENID,/)
  assert.match(refresh, /data: buildLoginData\(OPENID,/)
  assert.match(update, /openid: OPENID/)
  assert.doesNotMatch(authSource, /data\.openid|localUser\.openid/)

  const stored = { role: 'patient', nick_name: '患者' }
  const refreshed = { role: 'patient', nick_name: '患者新名' }
  const app = { globalData: { userInfo: null, role: null, openid: null } }
  const calls = []
  const sandbox = {
    module: { exports: {} },
    exports: {},
    getApp: () => app,
    wx: {
      getStorageSync: () => stored,
      setStorageSync: () => {},
      removeStorageSync: () => {}
    },
    console,
    require(request) {
      assert.equal(request, './api')
      return {
        async callFunction(name, event) {
          calls.push({ name, event })
          return refreshed
        }
      }
    }
  }
  vm.runInNewContext(authSource, sandbox)

  assert.equal(await sandbox.module.exports.refreshSession(), refreshed)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'login')
  assert.equal(calls[0].event.type, 'refresh')
  assert.equal(app.globalData.userInfo, refreshed)
  assert.equal(app.globalData.openid, null)
})

test('login cloud function logs fixed labels only', () => {
  const errorLogs = loginSource.split('\n')
    .filter(line => line.includes('console.error'))
    .map(line => line.trim())

  assert.deepEqual(errorLogs, [
    "console.error('LOGIN_NICKNAME_SECURITY_CHECK_FAILED')",
    "console.error('LOGIN_AVATAR_SECURITY_CHECK_FAILED')",
    "console.error('LOGIN_PHONE_LOOKUP_FAILED')",
    "console.error('LOGIN_TECHNICIAN_LOOKUP_FAILED')",
    "console.error('LOGIN_TECHNICIAN_REFRESH_FAILED')",
    "console.error('LOGIN_OPERATION_FAILED')"
  ])
})
