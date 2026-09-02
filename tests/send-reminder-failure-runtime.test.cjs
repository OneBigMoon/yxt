const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const target = path.resolve(__dirname, '../cloudfunctions/sendReminder/index.js')
const REMOVE = Symbol('remove')

function loadMain(t, { sendFailures = 1, finalizeFailures = 0, uncertainFailures = 0 } = {}) {
  const fixedTime = Date.parse('2026-08-31T01:00:00.000Z')
  const appointment = {
    _id: 'appointment-1',
    patient_openid: 'patient-1',
    date: '2026-08-31',
    start_time: '10:00',
    status: 'pending'
  }
  const state = { appointment, sendCalls: 0, finalizeAttempts: 0, uncertainAttempts: 0 }

  function applyUpdate(record, data) {
    for (const [key, value] of Object.entries(data)) {
      if (value === REMOVE) delete record[key]
      else record[key] = value
    }
  }

  function collection(name) {
    assert.equal(name, 'appointments')
    let query = {}
    return {
      where(next) { query = { ...query, ...next }; return this },
      async get() {
        const matches = Object.entries(query).every(([key, value]) => appointment[key] === value)
        return { data: matches ? [{ ...appointment }] : [] }
      },
      doc(id) {
        assert.equal(id, appointment._id)
        return {
          async get() { return { data: { ...appointment } } },
          async update({ data }) {
            if (data.reminder_sent_key) {
              state.finalizeAttempts += 1
              if (state.finalizeAttempts <= finalizeFailures) throw new Error('finalize failed')
            }
            if (data.reminder_delivery_uncertain_key) {
              state.uncertainAttempts += 1
              if (state.uncertainAttempts <= uncertainFailures) throw new Error('uncertain failed')
            }
            applyUpdate(appointment, data)
          }
        }
      }
    }
  }

  const db = {
    command: { remove: () => REMOVE },
    collection,
    serverDate: () => 'server-date',
    runTransaction: callback => callback({ collection })
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'current',
    init() {},
    database: () => db,
    getWXContext: () => ({ SOURCE: 'timer' }),
    openapi: {
      subscribeMessage: {
        async send() {
          state.sendCalls += 1
          if (state.sendCalls <= sendFailures) {
            const error = new Error('sensitive upstream message')
            error.errCode = 43101
            throw error
          }
        }
      }
    }
  }

  const RealDate = Date
  const originalLoad = Module._load
  const originalTemplate = process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_REMINDER
  const originalConsoleError = console.error
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedTime]))
    }
    static now() { return fixedTime }
  }

  global.Date = FixedDate
  process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_REMINDER = 'template-id'
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk' && parent && parent.filename === target) return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  console.error = () => {}
  delete require.cache[target]
  t.after(() => {
    global.Date = RealDate
    Module._load = originalLoad
    console.error = originalConsoleError
    if (originalTemplate === undefined) delete process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_REMINDER
    else process.env.SUBSCRIBE_TEMPLATE_APPOINTMENT_REMINDER = originalTemplate
    delete require.cache[target]
  })

  return { main: require(target).main, state }
}

test('reminder failure is persisted without sensitive text and cleared after success', async t => {
  const { main, state } = loadMain(t)
  const event = { Type: 'Timer', TriggerName: 'reminderTrigger' }

  assert.deepEqual(await main(event), { code: 0, data: { count: 0 } })
  assert.equal(state.appointment.reminder_failure_count, 1)
  assert.equal(state.appointment.reminder_last_failed_at, 'server-date')
  assert.equal(state.appointment.reminder_last_error_code, '43101')
  assert.equal('reminder_claim_token' in state.appointment, false)

  assert.deepEqual(await main(event), { code: 0, data: { count: 1 } })
  assert.equal(state.appointment.reminder_sent_key, 'appointment-reminder:appointment-1:2026-08-31:10:00')
  assert.equal('reminder_failure_count' in state.appointment, false)
  assert.equal('reminder_last_failed_at' in state.appointment, false)
  assert.equal('reminder_last_error_code' in state.appointment, false)
})

test('successful send with failed finalization becomes uncertain and is not sent again', async t => {
  const { main, state } = loadMain(t, { sendFailures: 0, finalizeFailures: 3 })
  const event = { Type: 'Timer', TriggerName: 'reminderTrigger' }

  assert.deepEqual(await main(event), { code: 0, data: { count: 0 } })
  assert.equal(state.sendCalls, 1)
  assert.equal(state.finalizeAttempts, 3)
  assert.equal(state.appointment.reminder_delivery_uncertain_key,
    'appointment-reminder:appointment-1:2026-08-31:10:00')
  assert.equal(state.appointment.reminder_delivery_uncertain_at, 'server-date')
  assert.equal('reminder_claim_token' in state.appointment, false)

  assert.deepEqual(await main(event), { code: 0, data: { count: 0 } })
  assert.equal(state.sendCalls, 1)
})

test('claim key prevents resend when finalization and uncertain persistence both fail', async t => {
  const { main, state } = loadMain(t, {
    sendFailures: 0,
    finalizeFailures: 3,
    uncertainFailures: 3
  })
  const event = { Type: 'Timer', TriggerName: 'reminderTrigger' }

  assert.deepEqual(await main(event), { code: 0, data: { count: 0 } })
  assert.equal(state.sendCalls, 1)
  assert.equal(state.finalizeAttempts, 3)
  assert.equal(state.uncertainAttempts, 3)
  assert.equal(state.appointment.reminder_claim_key,
    'appointment-reminder:appointment-1:2026-08-31:10:00')

  state.appointment.reminder_lease_until = Date.now() - 1
  assert.deepEqual(await main(event), { code: 0, data: { count: 0 } })
  assert.equal(state.sendCalls, 1)
})
