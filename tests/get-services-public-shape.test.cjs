const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const target = path.resolve(__dirname, '../cloudfunctions/getServices/index.js')

function loadMain(t) {
  const originalLoad = Module._load
  const records = [
    {
      _id: 'service-1',
      name: '标准服务',
      description: '基础服务',
      duration: 30,
      image_url: 'cloud://env/service.png',
      imageUrl: 'legacy-image',
      status: 'active',
      sort_order: 1,
      price: 100,
      default_commission: 20
    }
  ]
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'current',
    init() {},
    database() {
      return {
        command: {},
        collection(name) {
          assert.equal(name, 'services')
          return {
            where(query) {
              assert.deepEqual(query, { status: 'active' })
              return this
            },
            orderBy(field, direction) {
              assert.equal(field, 'sort_order')
              assert.equal(direction, 'asc')
              return this
            },
            async get() {
              return { data: records.map(record => ({ ...record })) }
            }
          }
        }
      }
    },
    async getTempFileURL({ fileList }) {
      assert.deepEqual(fileList, ['cloud://env/service.png'])
      return { fileList: [{ fileID: fileList[0], tempFileURL: 'https://cdn.test/service.png' }] }
    }
  }

  Module._load = function(request, parent, isMain) {
    if (request === 'wx-server-sdk' && parent && parent.filename === target) return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[target]
  t.after(() => {
    Module._load = originalLoad
    delete require.cache[target]
  })
  return require(target).main
}

test('public getServices response keeps app fields and removes internal fields', async t => {
  const main = loadMain(t)
  const result = await main({}, {})

  assert.deepEqual(result, {
    code: 0,
    data: [{
      _id: 'service-1',
      name: '标准服务',
      description: '基础服务',
      duration: 30,
      image_url: 'https://cdn.test/service.png'
    }]
  })
  assert.equal('default_commission' in result.data[0], false)
  assert.equal('price' in result.data[0], false)
  assert.equal('status' in result.data[0], false)
  assert.equal('sort_order' in result.data[0], false)
  assert.equal('imageUrl' in result.data[0], false)
})
