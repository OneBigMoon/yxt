const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const permissions = fs.readFileSync(path.join(root, 'admin-web/src/utils/permissions.js'), 'utf8')
const api = fs.readFileSync(path.join(root, 'admin-web/src/api/index.js'), 'utf8')

test('admin web keeps its session in admin_session only', () => {
  assert.match(permissions, /const SESSION_KEY = 'admin_session'/)
  assert.doesNotMatch(permissions, /sessionStorage\.getItem\(['"]admin_token/)
  assert.doesNotMatch(permissions, /sessionStorage\.setItem\(['"](?:admin_token|admin_info|admin_loggedin|admin_password)/)
  assert.doesNotMatch(api, /\badmin_token\s*:/)
})

test('admin web does not expose raw cloud errors', () => {
  assert.doesNotMatch(api, /console\.error/)
  assert.match(api, /const GENERIC_ERROR_TEXT = '请求失败，请稍后重试'/)
  assert.match(api, /publicError\.error_code = code/)
  assert.match(api, /publicError\.trace_id = \(err && err\.trace_id\) \|\| traceId/)
  assert.doesNotMatch(api, /notifyAuthInvalid\(normalized\)/)
})

test('admin web maps public operational error codes to actionable safe text', () => {
  assert.match(api, /CONFIG_CONFLICT:\s*'配置已被更新，请刷新后重试'/)
  assert.match(api, /RATE_LIMITED:\s*'操作过于频繁，请稍后重试'/)
})
