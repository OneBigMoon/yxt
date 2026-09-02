const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('admin exposes draft publish history and rollback workflow', () => {
  const api = read('admin-web/src/api/index.js')
  const view = read('admin-web/src/views/BusinessConfig.vue')

  for (const action of ['getConfigDraft', 'saveConfigDraft', 'publishConfig', 'getConfigVersions', 'rollbackConfig']) {
    assert.match(api, new RegExp(`callAdmin\\('${action}'`))
  }
  assert.match(view, /保存草稿/)
  assert.match(view, /发布到线上/)
  assert.match(view, /发布历史/)
  assert.match(view, /回滚到此版/)
  assert.match(view, /预约、记录、隐私、协议、取消和注销等核心功能不会被隐藏/)
})

test('mini-program renders only the fixed safe operating module allowlist', () => {
  const page = read('miniprogram/pages/index/index.js')
  const template = read('miniprogram/pages/index/index.wxml')
  const allowed = [
    'business_status',
    'recommended_services',
    'recommended_technicians',
    'articles'
  ]

  for (const key of allowed) {
    assert.match(page, new RegExp(`key: '${key}'`))
    assert.match(template, new RegExp(`module\\.key === '${key}'`))
  }

  assert.doesNotMatch(template, /module\.key === 'facilities'/)
  assert.doesNotMatch(template, /到店设施/)
  assert.doesNotMatch(template, /module\.key === 'announcement'/)
  assert.doesNotMatch(template, /announcement-section/)
  assert.match(page, /onReachBottom\(\)/)
  assert.match(page, /loadMoreArticles\(\)/)
  assert.match(template, /已经到底了/)
  assert.doesNotMatch(page, /key: '(?:booking|appointments|privacy|agreement|cancel|delete_account)'/)
  assert.match(page, /Array\.isArray\(config\.modules\)/)
  assert.match(template, /wx:for="\{\{homeModules\}\}"/)
})

test('admin cloud function keeps draft private and restricts rollback to super admin', () => {
  const cloud = read('cloudfunctions/admin/index.js')
  for (const action of ['getConfigDraft', 'saveConfigDraft', 'publishConfig', 'getConfigVersions', 'rollbackConfig']) {
    assert.match(cloud, new RegExp(`case '${action}'`))
    assert.match(cloud, new RegExp(`async function ${action}`))
  }
  assert.match(cloud, /adminAuth\.role !== 'super_admin'/)
  assert.match(cloud, /const \{[\s\S]*draft, published,[\s\S]*\.\.\.legacy[\s\S]*\} = document \|\| \{\}/)
  assert.match(cloud, /getPublishedOperationConfig\(document\)/)
  assert.match(cloud, /business_config_versions/)
  assert.match(cloud, /CONFIG_VERSION_KEEP_LIMIT = 30/)
  assert.doesNotMatch(cloud, /DYNAMIC_OPERATION_MODULES[\s\S]{0,800}key: '(?:booking|appointments|privacy|agreement|cancel|delete_account)'/)
})

test('safe production content initialization is explicit, idempotent and super-admin only', () => {
  const api = read('admin-web/src/api/index.js')
  const view = read('admin-web/src/views/BusinessConfig.vue')
  const cloud = read('cloudfunctions/admin/index.js')

  assert.match(api, /callAdmin\('initializeProductionContent'\)/)
  assert.match(view, /初始化安全生产内容/)
  assert.match(view, /不会虚构顾问、客户案例或评价/)
  assert.match(cloud, /case 'initializeProductionContent'/)
  assert.match(cloud, /adminAuth\.role !== 'super_admin'/)
  assert.match(cloud, /production_seed_version/)
  assert.match(cloud, /already_initialized: true/)
  assert.match(cloud, /serviceCount\.total[^]*=== 0/)
  assert.match(cloud, /articleCount\.total[^]*=== 0/)
})
