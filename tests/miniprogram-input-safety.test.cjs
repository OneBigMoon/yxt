const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function loadDefinition(file, register) {
  const source = fs.readFileSync(file, 'utf8')
  const context = {
    [register]: value => { context.definition = value },
    wx: { showModal() {}, navigateBack() {} }
  }
  vm.runInNewContext(source, context, { filename: file })
  return context.definition
}

const app = loadDefinition('miniprogram/app.js', 'App')
const page = loadDefinition('miniprogram/pages/scan-confirm/scan-confirm.js', 'Page')
const sessionId = 'a'.repeat(32)

assert.equal(app._extractSessionIdFromLink(`?session_id=${encodeURIComponent(sessionId)}`), sessionId)
assert.equal(app._extractSessionIdFromLink('?session_id=%ZZ'), '')
assert.equal(app._safeDecode(123), '')
assert.equal(app._safeDecode('x'.repeat(2049)), '')

assert.equal(page.getSessionIdFromOptions.call(page, { session_id: '%ZZ' }), '')
assert.equal(page.getSessionIdFromOptions.call(page, { session_id: 123 }), '')
assert.equal(page.getSessionIdFromOptions.call(page, { session_id: 'x'.repeat(2049) }), '')
assert.equal(page.getSessionIdFromOptions.call(page, { scene: '%ZZ' }), '')
assert.equal(page.getSessionIdFromOptions.call(page, { q: '%ZZ' }), '')
assert.equal(page.getSessionIdFromOptions.call(page, {
  q: encodeURIComponent(`https://example.test/scan?session_id=${sessionId}`)
}), sessionId)

let confirmCalls = 0
const invalidPage = {
  ...page,
  data: { ...page.data },
  setData(update) { this.data = { ...this.data, ...update } },
  onConfirm() { confirmCalls += 1 }
}
invalidPage.onLoad.call(invalidPage, { session_id: '%ZZ' })
assert.equal(confirmCalls, 0)

console.log('miniprogram input safety checks passed')
