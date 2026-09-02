const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const target = path.resolve(__dirname, '../cloudfunctions/verifyAppointment/index.js')

function beijingDateAfter(days = 0) {
  const date = new Date(Date.now() + (days + 1 / 3) * 24 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function loadMain(t, { appointment, candidates = {}, commissionError, commissionFailAt = 1, services = [] } = {}) {
  const calls = { appointmentUpdate: 0, commissionSet: 0, transaction: 0 }
  const technician = { _id: 'technician-1', openid: 'tech-openid', status: 'active', name: '测试人员' }
  const serviceRecords = new Map((services.length ? services : [{ _id: 'service-1', name: '服务 A', price: 100, default_commission: 10 }]).map(service => [service._id, service]))
  const state = { appointment: { ...appointment, services: [...(appointment.services || [])] }, commissionRecords: new Map() }
  const createTransaction = pending => ({
    collection(name) {
      if (name === 'appointments') return { doc: () => ({ get: async () => ({ data: state.appointment }), update: async ({ data }) => { calls.appointmentUpdate += 1; pending.appointmentUpdate = data } }) }
      if (name === 'technicians') return { doc: () => ({ get: async () => ({ data: technician }) }) }
      if (name === 'services') return { doc: id => ({ get: async () => ({ data: serviceRecords.get(id) }) }) }
      if (name === 'commission_records') return { doc: id => ({ set: async ({ data }) => { calls.commissionSet += 1; if (commissionError && calls.commissionSet === commissionFailAt) throw commissionError; pending.commissionRecords.set(id, data) } }) }
      throw new Error(`unexpected transaction collection: ${name}`)
    }
  })
  const db = {
    collection(name) {
      if (name === 'technicians') return { where: () => ({ limit: () => ({ get: async () => ({ data: [technician] }) }) }) }
      if (name === 'appointments') {
        return {
          where: query => ({ limit: () => ({ get: async () => ({ data: candidates[query.verify_code ? 'verify_code' : 'qr_scene'] || [] }) }) }),
          doc: () => ({ get: async () => ({ data: appointment }) })
        }
      }
      throw new Error(`unexpected database collection: ${name}`)
    },
    runTransaction: async callback => {
      calls.transaction += 1
      const pending = { appointmentUpdate: null, commissionRecords: new Map() }
      const result = await callback(createTransaction(pending))
      if (pending.appointmentUpdate) Object.assign(state.appointment, pending.appointmentUpdate)
      for (const [id, record] of pending.commissionRecords) state.commissionRecords.set(id, record)
      return result
    },
    serverDate: () => 'server-date'
  }
  const cloud = { DYNAMIC_CURRENT_ENV: 'current', init: () => {}, database: () => db, getWXContext: () => ({ OPENID: 'tech-openid' }) }
  const originalLoad = Module._load
  const originalConsoleError = console.error
  delete require.cache[target]
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk' && parent && parent.filename === target) return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  console.error = () => {}
  t.after(() => {
    Module._load = originalLoad
    console.error = originalConsoleError
    delete require.cache[target]
  })
  return { main: require(target).main, calls, state }
}

test('second commission failure rolls back all staged verification writes', async t => {
  const appointment = { _id: 'appointment-1', date: beijingDateAfter(), status: 'pending', start_time: '00:00', services: ['service-1', 'service-2'] }
  const { main, calls, state } = loadMain(t, {
    appointment,
    candidates: { verify_code: [appointment] },
    commissionError: new Error('second commission write failed'),
    commissionFailAt: 2,
    services: [
      { _id: 'service-1', name: '服务 A', price: 100, default_commission: 10 },
      { _id: 'service-2', name: '服务 B', price: 200, default_commission: 20 }
    ]
  })

  assert.deepEqual(await main({ id: '123456' }, {}), { code: -1, message: '核销预约失败，请稍后重试' })
  assert.deepEqual(calls, { appointmentUpdate: 0, commissionSet: 2, transaction: 1 })
  assert.deepEqual(state.appointment, appointment)
  assert.deepEqual([...state.commissionRecords], [])
})

test('future appointment ID is rejected before any transaction writes', async t => {
  const appointment = { _id: 'appointment-1', date: beijingDateAfter(1), status: 'pending', start_time: '00:00', services: ['service-1'] }
  const { main, calls } = loadMain(t, { appointment })

  assert.deepEqual(await main({ id: appointment._id }, {}), { code: -1, message: '仅可核销当天待处理预约' })
  assert.deepEqual(calls, { appointmentUpdate: 0, commissionSet: 0, transaction: 1 })
})

test('ambiguous numeric code does not start a transaction', async t => {
  const appointment = { _id: 'appointment-1', date: beijingDateAfter(), status: 'pending', start_time: '00:00', services: ['service-1'] }
  const { main, calls } = loadMain(t, {
    appointment,
    candidates: {
      verify_code: [appointment],
      qr_scene: [{ ...appointment, _id: 'appointment-2' }]
    }
  })

  assert.deepEqual(await main({ id: '123456' }, {}), { code: -1, message: '核销信息存在冲突，请改用预约记录核销' })
  assert.deepEqual(calls, { appointmentUpdate: 0, commissionSet: 0, transaction: 0 })
})
