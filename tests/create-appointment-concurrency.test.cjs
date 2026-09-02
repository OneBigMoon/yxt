const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const target = path.resolve(__dirname, '../cloudfunctions/createAppointment/index.js')

function tomorrowInBeijing() {
  const date = new Date(Date.now() + 32 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function loadMain(t, { replaceLockAfterRead = false, sameOpenid = false, failBookingCompletionOnce = false } = {}) {
  const date = tomorrowInBeijing()
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7
  const state = {
    appointments: new Map(),
    locks: new Map(),
    firstReadReplacedLock: false,
    bookingCompletionFailures: 0,
    appointmentReadCalls: 0,
    downstreamReadCalls: 0,
    unlockedReaders: []
  }
  let transactionTail = Promise.resolve()
  let contextCalls = 0

  function records(name) {
    if (name === 'appointments') return state.appointments
    if (name === 'login_sessions') return state.locks
    if (!state[name]) state[name] = new Map()
    return state[name]
  }

  function matches(record, query) {
    return Object.entries(query).every(([key, value]) => {
      return value && value.__in ? value.__in.includes(record[key]) : record[key] === value
    })
  }

  function appointmentRead(query) {
    state.appointmentReadCalls += 1
    const current = [...state.appointments.values()].filter(record => matches(record, query))
    const lock = state.locks.get(`booking_lock_${date}`)
    const wasLocked = lock && lock.status === 'locked' && lock.owner
    if (replaceLockAfterRead && !state.firstReadReplacedLock && wasLocked) {
      state.firstReadReplacedLock = true
      state.locks.set(`booking_lock_${date}`, {
        ...lock,
        status: 'released',
        owner: '',
        fence: lock.fence + 1,
        expires_at: 0
      })
    }
    if (wasLocked) return Promise.resolve(current)

    return new Promise(resolve => {
      state.unlockedReaders.push(resolve)
      if (state.unlockedReaders.length === 2) {
        const readers = state.unlockedReaders.splice(0)
        readers.forEach(reader => reader(current))
      }
    })
  }

  function collection(name) {
    let query = {}
    let skip = 0
    let limit = Infinity
    return {
      where(next) { query = { ...query, ...next }; return this },
      skip(next) { skip = next; return this },
      limit(next) { limit = next; return this },
      async get() {
        if (['services', 'holidays', 'business_config', 'technicians', 'tech_days_off'].includes(name)) {
          state.downstreamReadCalls += 1
        }
        const data = name === 'appointments'
          ? await appointmentRead(query)
          : [...records(name).values()].filter(record => matches(record, query))
        return { data: data.slice(skip, skip + limit).map(record => ({ ...record })) }
      },
      doc(id) {
        return {
          get: async () => ({ data: records(name).get(id) }),
          update: async ({ data }) => records(name).set(id, { ...records(name).get(id), ...data }),
          set: async ({ data }) => records(name).set(id, { _id: id, ...data })
        }
      },
      async add({ data }) {
        if (records(name).has(data._id)) throw new Error('duplicate _id')
        records(name).set(data._id, { ...data })
      }
    }
  }

  const db = {
    command: { in: values => ({ __in: values }) },
    collection,
    serverDate: () => 'server-date',
    runTransaction(callback) {
      const run = transactionTail.then(async () => {
        const writes = []
        const transaction = {
          collection(name) {
            return {
              doc(id) {
                return {
                  get: async () => ({ data: records(name).get(id) }),
                  update: async ({ data }) => {
                    if (failBookingCompletionOnce && name === 'users' && data.booking_last_qr_code &&
                        state.bookingCompletionFailures === 0) {
                      state.bookingCompletionFailures += 1
                      throw new Error('simulated booking completion failure')
                    }
                    writes.push(() => records(name).set(id, { ...records(name).get(id), ...data }))
                  },
                  set: async ({ data }) => writes.push(() => records(name).set(id, { _id: id, ...data }))
                }
              }
            }
          }
        }
        const result = await callback(transaction)
        writes.forEach(write => write())
        return result
      })
      transactionTail = run.catch(() => {})
      return run
    }
  }
  ;[
    ['users', { _id: 'user-1', openid: 'patient-one' }],
    ['users', { _id: 'user-2', openid: 'patient-two' }],
    ['services', { _id: 'service-1', status: 'active', duration: 30 }],
    ['business_config', { _id: 'config-1', max_advance_days: 14, slot_interval: 30, schedule: { [day]: [{ start: '09:00', end: '18:00' }] } }],
    ['technicians', { _id: 'tech-1', status: 'active' }]
  ].forEach(([name, record]) => records(name).set(record._id, record))

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'current',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: sameOpenid ? 'patient-one' : (contextCalls++ ? 'patient-two' : 'patient-one') }),
    openapi: { wxacode: { getUnlimited: async () => ({ buffer: Buffer.from('qr') }) } },
    uploadFile: async () => ({ fileID: 'cloud://qr' })
  }
  const originalLoad = Module._load
  const originalConsoleError = console.error
  const originalConsoleWarn = console.warn
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk' && parent && parent.filename === target) return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  console.error = () => {}
  console.warn = () => {}
  delete require.cache[target]
  t.after(() => {
    Module._load = originalLoad
    console.error = originalConsoleError
    console.warn = originalConsoleWarn
    delete require.cache[target]
  })
  return { main: require(target).main, state, date }
}

function booking(date, request_id, overrides = {}) {
  return {
    services: ['service-1'],
    date,
    start_time: '10:00',
    end_time: '10:30',
    total_duration: 30,
    request_id,
    ...overrides
  }
}

test('one-seat concurrent bookings serialize and release the date lock', async t => {
  const { main, state, date } = loadMain(t)
  const results = await Promise.all([
    main(booking(date, 'request-one-0001')),
    main(booking(date, 'request-two-0002'))
  ])

  assert.equal(results.filter(result => result.code === 0).length, 1)
  assert.ok(results.some(result => result.code === -1 && /当前预约请求较多|该时段已约满/.test(result.message)))
  assert.equal(state.appointments.size, 1)
  assert.equal(new Set([...state.appointments.values()].map(appointment => appointment.request_id)).size, 1)
  assert.deepEqual(state.locks.get(`booking_lock_${date}`), {
    _id: `booking_lock_${date}`, type: 'booking_capacity_lock', status: 'released', owner: '', fence: 2, expires_at: 0,
    updated_at: state.locks.get(`booking_lock_${date}`).updated_at
  })
})

test('same user cooldown rejects a different request and replays one cached idempotent result', async t => {
  const { main, state, date } = loadMain(t, { sameOpenid: true })
  const first = await main(booking(date, 'request-one-0001'))
  const appointmentReads = state.appointmentReadCalls
  const downstreamReads = state.downstreamReadCalls
  const limited = await main(booking(date, 'request-two-0002'))
  const retry = await main(booking(date, 'request-one-0001'))
  const replayLimited = await main(booking(date, 'request-one-0001'))

  assert.equal(first.code, 0)
  assert.deepEqual(limited, { code: -1, message: '操作过于频繁，请稍后重试' })
  assert.deepEqual(retry, first)
  assert.deepEqual(replayLimited, { code: -1, message: '操作过于频繁，请稍后重试' })
  assert.equal(state.appointmentReadCalls, appointmentReads)
  assert.equal(state.downstreamReadCalls, downstreamReads)
  assert.equal(state.appointments.size, 1)
})

test('same request recovers a committed booking when result caching fails once', async t => {
  const { main, state, date } = loadMain(t, { sameOpenid: true, failBookingCompletionOnce: true })
  const request = booking(date, 'request-recovery-0003')
  const first = await main(request)
  const retry = await main(request)

  assert.equal(first.code, 0)
  assert.deepEqual(retry, first)
  assert.equal(state.bookingCompletionFailures, 1)
  assert.equal(state.appointments.size, 1)
  assert.equal(state.users.get('user-1').booking_last_appointment_id, first.data._id)
  assert.equal(state.users.get('user-1').booking_last_qr_code, first.data.qr_code)
})

test('same failed request remains rate limited during the cooldown', async t => {
  const { main, state, date } = loadMain(t, { sameOpenid: true })
  const request = booking(date, 'request-failed-0005', { services: ['missing-service'] })
  const first = await main(request)
  const downstreamReads = state.downstreamReadCalls
  const retry = await main(request)

  assert.deepEqual(first, { code: -1, message: '服务项目已调整，请刷新后重新选择' })
  assert.deepEqual(retry, { code: -1, message: '操作过于频繁，请稍后重试' })
  assert.equal(state.downstreamReadCalls, downstreamReads)
  assert.equal(state.appointments.size, 0)
})

test('legacy request without request_id is rate limited during the cooldown', async t => {
  const { main, state, date } = loadMain(t, { sameOpenid: true })
  const first = await main(booking(date))
  const retry = await main(booking(date))

  assert.equal(first.code, 0)
  assert.deepEqual(retry, { code: -1, message: '操作过于频繁，请稍后重试' })
  assert.equal(state.appointments.size, 1)
})

test('idempotent retry treats omitted and authoritative end_time as equivalent', async t => {
  const { main, state, date } = loadMain(t, { sameOpenid: true })
  const first = await main(booking(date, 'request-equivalent-0004', { end_time: undefined }))
  const downstreamReads = state.downstreamReadCalls
  const retry = await main(booking(date, 'request-equivalent-0004'))

  assert.equal(first.code, 0)
  assert.deepEqual(retry, first)
  assert.equal(state.downstreamReadCalls, downstreamReads)
  assert.equal(state.appointments.size, 1)
})

test('a stale fenced lease cannot commit an appointment', async t => {
  const { main, state, date } = loadMain(t, { replaceLockAfterRead: true })
  const result = await main(booking(date, 'request-fence-0003'))
  const lock = state.locks.get(`booking_lock_${date}`)

  assert.deepEqual(result, { code: -1, message: '当前预约请求较多，请稍后重试' })
  assert.equal(state.appointments.size, 0)
  assert.equal(lock.status, 'released')
  assert.equal(lock.owner, '')
  assert.equal(lock.fence, 2)
})
