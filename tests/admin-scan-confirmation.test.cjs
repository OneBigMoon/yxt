const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('scan login requires an explicit, identifiable user confirmation', () => {
  const page = read('miniprogram/pages/scan-confirm/scan-confirm.js')
  const template = read('miniprogram/pages/scan-confirm/scan-confirm.wxml')
  const login = read('admin-web/src/views/Login.vue')
  const adminUsers = read('admin-web/src/views/AdminUsers.vue')
  const onLoad = page.slice(
    page.indexOf('onLoad(options)'),
    page.indexOf('\n\n  getSessionIdFromOptions(options')
  )

  assert.doesNotMatch(onLoad, /this\.onConfirm\(\)/)
  assert.match(onLoad, /sessionHint: sessionId\.slice\(-6\)\.toUpperCase\(\)/)
  assert.match(page, /onCancel\(\)[\s\S]{0,120}this\.returnToCallerOrHome\(\)/)
  assert.match(template, /操作尾号：\{\{sessionHint\}\}/)
  assert.match(template, /如果你没有在电脑上主动发起操作，请立即取消。/)
  assert.match(template, /bindtap="onCancel"/)
  assert.match(template, /bindtap="onConfirm"/)
  assert.match(login, /操作尾号：\{\{ sessionId\.slice\(-6\)\.toUpperCase\(\) \}\}/)
  assert.match(adminUsers, /操作尾号：\{\{ bindSessionId\.slice\(-6\)\.toUpperCase\(\) \}\}/)
  assert.doesNotMatch(login, /自动确认/)
  assert.doesNotMatch(adminUsers, /自动绑定/)
})
