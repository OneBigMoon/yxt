const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const privacyFallback = source => source.match(/showPrivacyFallback\(\)\s*\{[\s\S]*?content: ('(?:[^'\\]|\\.)*')/)[1]

test('privacy fallbacks agree and link configured contact to native calling', () => {
  const login = read('miniprogram/pages/login/login.js')
  const mine = read('miniprogram/pages/mine/mine.js')
  const index = read('miniprogram/pages/index/index.js')
  const template = read('miniprogram/pages/index/index.wxml')

  assert.equal(privacyFallback(login), privacyFallback(mine))
  assert.match(login, /本预约服务小程序/)
  assert.match(login, /相机或相册选择二维码/)
  assert.match(login, /不会持续读取您的位置/)
  assert.match(login, /首页已配置的“联系门店”/)
  assert.match(index, /callStorePhone\(\)[\s\S]*wx\.makePhoneCall\(\{ phoneNumber: phone \}\)/)
  assert.match(template, /wx:if="\{\{clinicInfo\.phone\}\}"/)
  assert.match(template, /bindtap="callStorePhone"/)
})

test('published store configuration requires a reachable contact path', () => {
  const cloud = read('cloudfunctions/admin/index.js')
  const admin = read('admin-web/src/views/BusinessConfig.vue')

  assert.match(cloud, /if \(!\/\^1\\d\{10\}\$\/\.test\(phone\)\)/)
  assert.match(cloud, /请填写有效的门店联系电话/)
  assert.match(cloud, /请填写有效的门店地址/)
  assert.match(cloud, /请填写有效的门店坐标/)
  assert.match(cloud, /sanitized\.store = \{ name: storeName, phone, address, latitude, longitude \}/)
  assert.match(admin, /if \(!\/\^1\\d\{10\}\$\/\.test\(config\.value\.store\.phone\.trim\(\)\)\)/)
  assert.match(admin, /请输入有效门店坐标/)
})

test('default store configuration fails closed until real operating details are entered', () => {
  const cloud = read('cloudfunctions/admin/index.js')
  const admin = read('admin-web/src/views/BusinessConfig.vue')

  for (const source of [cloud, admin]) {
    assert.doesNotMatch(source, /36\.595557|116\.955628|1740240895264492077|百花明都/)
    assert.match(source, /address:\s*''/)
    assert.match(source, /latitude:\s*null/)
    assert.match(source, /longitude:\s*null/)
  }
  assert.match(cloud, /schedule:\s*\{\s*1:\s*\[\],\s*2:\s*\[\],\s*3:\s*\[\],\s*4:\s*\[\],\s*5:\s*\[\],\s*6:\s*\[\],\s*7:\s*\[\]/)
})

test('navigation never invents a fallback address or coordinate', () => {
  const index = read('miniprogram/pages/index/index.js')
  const mine = read('miniprogram/pages/mine/mine.js')

  for (const source of [index, mine]) {
    assert.match(source, /if \(!hasConfiguredLocation\)/)
    assert.match(source, /暂无门店位置信息/)
    assert.doesNotMatch(source, /36\.595557|116\.955628|百花明都/)
  }
})
