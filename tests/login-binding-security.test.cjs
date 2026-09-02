const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/login/index.js'), 'utf8')
const start = source.indexOf('async function findActiveTechnicianByPhone')
const end = source.indexOf('\nasync function findActiveTechnicianForUser', start)

assert.ok(start >= 0 && end > start, 'technician phone lookup must exist')

function createFinder(technicians) {
  const updates = []
  const db = {
    collection(name) {
      assert.equal(name, 'technicians')
      return {
        where(query) {
          return {
            async get() {
              return {
                data: technicians.filter(technician => (
                  technician.phone === query.phone && technician.status === query.status
                ))
              }
            }
          }
        },
        doc(id) {
          return {
            async update(payload) {
              updates.push({ id, payload })
            }
          }
        }
      }
    },
    serverDate() {
      return 'server-date'
    }
  }

  const find = new Function('db', `${source.slice(start, end)}\nreturn findActiveTechnicianByPhone`)(db)
  return { find, updates }
}

test('an unbound technician phone binds to the first OpenID', async () => {
  const technician = { _id: 'tech-1', phone: '13800000000', status: 'active', openid: '' }
  const { find, updates } = createFinder([technician])

  assert.equal(await find(technician.phone, 'openid-1'), technician)
  assert.deepEqual(updates, [{
    id: technician._id,
    payload: { data: { openid: 'openid-1', updated_at: 'server-date' } }
  }])
})

test('a technician phone already bound to the same OpenID keeps its role without writing', async () => {
  const technician = { _id: 'tech-1', phone: '13800000000', status: 'active', openid: 'openid-1' }
  const { find, updates } = createFinder([technician])

  assert.equal(await find(technician.phone, 'openid-1'), technician)
  assert.deepEqual(updates, [])
})

test('a technician phone bound to another OpenID grants no role and performs no write', async () => {
  const technician = { _id: 'tech-1', phone: '13800000000', status: 'active', openid: 'openid-owner' }
  const { find, updates } = createFinder([technician])

  assert.equal(await find(technician.phone, 'openid-attacker'), null)
  assert.deepEqual(updates, [])
})

test('an ordinary user phone remains unbound', async () => {
  const { find, updates } = createFinder([])

  assert.equal(await find('13900000000', 'openid-user'), null)
  assert.deepEqual(updates, [])
})
