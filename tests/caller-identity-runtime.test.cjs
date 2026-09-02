const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

test('admin sessions reject non-default tenant scopes in the single-store model', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/admin/index.js'), 'utf8')

  assert.match(source, /const tenantScope = DEFAULT_TENANT_SCOPE/)
  assert.match(source, /if \(resolvedTenantScope !== DEFAULT_TENANT_SCOPE\) \{\s*return null/)
})

function loadMain(t, relativePath, { openid = '', db } = {}) {
  const target = path.resolve(root, relativePath)
  let collectionCalls = 0
  const database = db || {
    command: { in: values => ({ values }) },
    collection() {
      collectionCalls += 1
      throw new Error('database must not be accessed without caller identity')
    },
    serverDate: () => 'server-date'
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'current',
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
    openapi: {
      phonenumber: { getPhoneNumber: async () => { throw new Error('must not call OpenAPI') } },
      subscribeMessage: { send: async () => { throw new Error('must not send') } },
      wxacode: { getUnlimited: async () => { throw new Error('must not create QR code') } }
    }
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk' && parent && parent.filename === target) return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[target]
  t.after(() => {
    Module._load = originalLoad
    delete require.cache[target]
  })
  return { main: require(target).main, collectionCalls: () => collectionCalls }
}

const missingIdentityCases = [
  ['login', 'cloudfunctions/login/index.js', { type: 'login', phoneCode: 'code' }],
  ['patient appointment list', 'cloudfunctions/getMyAppointments/index.js', {}],
  ['staff appointment list', 'cloudfunctions/getAppointments/index.js', {}],
  ['appointment cancellation', 'cloudfunctions/cancelAppointment/index.js', { id: 'appointment-1' }],
  ['appointment verification', 'cloudfunctions/verifyAppointment/index.js', { id: '123456' }]
]

for (const [name, relativePath, event] of missingIdentityCases) {
  test(`${name} rejects a missing OpenID before database access`, async t => {
    const { main, collectionCalls } = loadMain(t, relativePath)
    const result = await main(event, {})

    assert.equal(result.code, -1)
    assert.match(result.message, /登录/)
    assert.equal(collectionCalls(), 0)
  })
}

test('patient appointment response exposes only the client contract', async t => {
  const appointment = {
    _id: 'appointment-1',
    patient_openid: 'patient-1',
    services: ['service-1'],
    date: '2026-09-01',
    start_time: '09:00',
    end_time: '09:30',
    total_duration: 30,
    status: 'completed',
    technician_id: 'technician-1',
    verify_code: '123456',
    qr_scene: '0123456789abcdef0123456789abcdef',
    qr_code: 'cloud://env/qr.jpg',
    verified_at: 'server-date',
    request_id: 'request-private',
    request_fingerprint: 'fingerprint-private',
    reminder_claim_token: 'lease-private',
    reminder_last_error: 'internal-private'
  }
  const db = {
    command: { in: values => ({ values }) },
    serverDate: () => 'server-date',
    collection(name) {
      if (name === 'appointments') {
        return {
          where() { return this },
          orderBy() { return this },
          get: async () => ({ data: [{ ...appointment }] })
        }
      }
      if (name === 'services') {
        return { where() { return this }, get: async () => ({ data: [{ name: '服务 A' }] }) }
      }
      if (name === 'technicians') {
        return { doc: () => ({ get: async () => ({ data: { name: '顾问 A' } }) }) }
      }
      throw new Error(`unexpected collection: ${name}`)
    }
  }
  const { main } = loadMain(t, 'cloudfunctions/getMyAppointments/index.js', {
    openid: 'patient-1',
    db
  })

  const result = await main({ status: 'completed' }, {})

  assert.deepEqual(result, {
    code: 0,
    data: [{
      _id: 'appointment-1',
      services: ['service-1'],
      date: '2026-09-01',
      start_time: '09:00',
      end_time: '09:30',
      total_duration: 30,
      status: 'completed',
      technician_id: 'technician-1',
      verify_code: '123456',
      qr_scene: '0123456789abcdef0123456789abcdef',
      qr_code: 'cloud://env/qr.jpg',
      verified_at: 'server-date',
      service_names: '服务 A',
      technician_name: '顾问 A'
    }]
  })
})
