const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('admin web does not directly upload files with its CloudBase client', () => {
  const api = read('admin-web/src/api/index.js')
  assert.doesNotMatch(api, /\bapp\.uploadFile\s*\(/)
  assert.doesNotMatch(api, /\bexport async function upload(?:File|PersistentFile)\b/)
})

test('service and article editors accept existing URLs without upload controls', () => {
  for (const file of ['admin-web/src/views/Services.vue', 'admin-web/src/views/Articles.vue']) {
    const source = read(file)
    assert.doesNotMatch(source, /<el-upload\b/)
    assert.doesNotMatch(source, /\buploadFile\s*\(/)
    assert.match(source, /已有图片 URL|已有封面和正文图片 URL/)
  }
})

test('business branding accepts an existing cloud file id without upload controls', () => {
  const source = read('admin-web/src/views/BusinessConfig.vue')

  assert.doesNotMatch(source, /<el-upload\b/)
  assert.doesNotMatch(source, /\buploadPersistentFile\b/)
  assert.match(source, /粘贴 cloud:\/\/ 文件 ID/)
  assert.match(source, /fileID\.startsWith\('cloud:\/\/'\)/)
})
