const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const FORBIDDEN_OLD_LOGO_SHA256 = '6945b473d0b0b5c1b846216cabb6bf2f8ac6ef905ed16eddaff026a310dcf1d6'

function sha256File(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex')
}

test('branding normalization keeps a persistent cloud logo and safe fallback', () => {
  const brandingFile = path.join(root, 'miniprogram/utils/branding.js')
  assert.equal(fs.existsSync(brandingFile), true, 'branding utility must exist')
  const { DEFAULT_LOGO, normalizeBranding } = require(brandingFile)

  assert.equal(DEFAULT_LOGO, '/images/logo-business.png')
  assert.deepEqual(
    normalizeBranding({ branding: { logo_file_id: 'cloud://env/logo.png', watermark_enabled: false } }),
    {
      logoFileId: 'cloud://env/logo.png',
      logoSrc: 'cloud://env/logo.png',
      watermarkEnabled: false
    }
  )
  assert.equal(normalizeBranding({}).logoSrc, DEFAULT_LOGO)
})

test('all mini-program WXML files use the shared brand component', () => {
  const pagesDir = path.join(root, 'miniprogram/pages')
  const files = fs.readdirSync(pagesDir).flatMap(page => {
    const file = path.join(pagesDir, page, `${page}.wxml`)
    return fs.existsSync(file) ? [file] : []
  })
  const offenders = files.filter(file => fs.readFileSync(file, 'utf8').includes('/images/logo.jpg'))

  assert.deepEqual(offenders, [])
})

test('business logo assets and runtime fallbacks use the new company mark', () => {
  const brandingSource = fs.readFileSync(path.join(root, 'miniprogram/utils/branding.js'), 'utf8')
  const customersSource = fs.readFileSync(path.join(root, 'admin-web/src/views/Customers.vue'), 'utf8')

  assert.match(brandingSource, /\/images\/logo-business\.png/)
  assert.match(customersSource, /\/logo-business\.png/)
  assert.doesNotMatch(brandingSource, /\/images\/logo\.jpg/)
  assert.doesNotMatch(customersSource, /\/logo\.jpg/)
  assert.equal(fs.existsSync(path.join(root, 'miniprogram/images/logo-business.png')), true)
  assert.equal(fs.existsSync(path.join(root, 'admin-web/public/logo-business.png')), true)
})

test('legacy logo paths and package lock roots use business-safe defaults', () => {
  const adminPackage = JSON.parse(fs.readFileSync(path.join(root, 'admin-web/package.json'), 'utf8'))
  const adminLock = JSON.parse(fs.readFileSync(path.join(root, 'admin-web/package-lock.json'), 'utf8'))
  const miniPackage = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/package.json'), 'utf8'))
  const miniLock = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/package-lock.json'), 'utf8'))
  const legacyLogoPaths = ['admin-web/public/logo.jpg', 'miniprogram/images/logo.jpg']
  const legacyLogoHashes = legacyLogoPaths.map(sha256File)

  assert.equal(adminLock.name, adminPackage.name)
  assert.equal(adminLock.packages[''].name, adminPackage.name)
  assert.equal(miniLock.name, miniPackage.name)
  assert.equal(miniLock.packages[''].name, miniPackage.name)
  assert.equal(legacyLogoHashes[0], legacyLogoHashes[1])
  assert.notEqual(legacyLogoHashes[0], FORBIDDEN_OLD_LOGO_SHA256)
  legacyLogoPaths.forEach(relativePath => {
    const bytes = fs.readFileSync(path.join(root, relativePath))
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', `${relativePath} must be a JPEG`)
  })
  assert.equal(fs.existsSync(path.join(root, 'miniprogram/images/logo-business.png')), true)
  assert.equal(fs.existsSync(path.join(root, 'admin-web/public/logo-business.png')), true)
})

test('business consulting/company mappings are explicit across shipped defaults', () => {
  const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
  const projectConfig = JSON.parse(read('project.config.json'))
  const packageConfig = JSON.parse(read('miniprogram/package.json'))

  assert.equal(projectConfig.projectname, 'yingsheng-appointment')
  assert.equal(projectConfig.description, '营生预约小程序')
  assert.equal(packageConfig.name, 'business-consulting-miniprogram')
  assert.equal(packageConfig.description, '营生预约小程序')
  assert.match(read('admin-web/src/App.vue'), />商务咨询预约</)
  assert.match(read('admin-web/index.html'), /<title>商务咨询预约管理后台<\/title>/)
  assert.match(read('admin-web/package.json'), /"description": "商务咨询预约管理后台"/)
  assert.match(read('admin-web/src/views/Login.vue'), />山东营生科贸有限公司</)
  assert.match(read('admin-web/src/views/BusinessConfig.vue'), /name: '山东营生科贸有限公司'/)
  assert.match(read('cloudfunctions/admin/index.js'), /name: '山东营生科贸有限公司'/)
  assert.match(read('miniprogram/pages/login/login.wxml'), />山东营生科贸有限公司</)
  assert.match(read('miniprogram/pages/index/index.js'), /name: clinicInfo\.name \|\| '山东营生科贸有限公司'/)
  assert.match(read('miniprogram/pages/mine/mine.js'), /name: clinicInfo\.name \|\| '山东营生科贸有限公司'/)
  assert.match(read('cloudfunctions/admin/index.js'), /title: '营业状态'/)
  assert.match(read('cloudfunctions/admin/index.js'), /title: '推荐顾问'/)
  assert.match(read('cloudfunctions/admin/index.js'), /title: '企业资讯'/)
  assert.match(read('miniprogram/pages/login/login.js'), /企业服务信息展示与预约登记/)
  assert.match(read('miniprogram/pages/index/index.wxml'), />营业状态</)
  assert.match(read('miniprogram/pages/index/index.wxml'), />推荐顾问</)
  assert.match(read('miniprogram/pages/index/index.wxml'), />资讯中心</)
  assert.match(read('miniprogram/pages/index/index.wxml'), /资讯文章/)
  assert.match(read('miniprogram/pages/index/index.wxml'), /企业动态与服务信息将在此发布/)
  assert.match(read('miniprogram/pages/article-detail/article-detail.wxml'), />资讯文章</)
  assert.match(read('cloudfunctions/verifyAppointment/index.js'), /仅顾问可核销/)
  assert.match(read('cloudfunctions/checkAvailability/index.js'), /暂无可预约顾问/)
  assert.match(read('cloudfunctions/getAvailableSlots/index.js'), /顾问休假/)
})

const BRANDING_SCAN_FILES = [
  'project.config.json',
  'miniprogram/package.json',
  'miniprogram/pages/index/index.js',
  'miniprogram/pages/index/index.wxml',
  'miniprogram/pages/login/login.js',
  'miniprogram/pages/login/login.wxml',
  'miniprogram/pages/mine/mine.js',
  'miniprogram/pages/article-detail/article-detail.wxml',
  'admin-web/src/App.vue',
  'admin-web/index.html',
  'admin-web/package.json',
  'admin-web/src/api/index.js',
  'admin-web/src/router/index.js',
  'admin-web/src/utils/permissions.js',
  'admin-web/src/views/Login.vue',
  'admin-web/src/views/Dashboard.vue',
  'admin-web/src/views/Appointments.vue',
  'admin-web/src/views/Articles.vue',
  'admin-web/src/views/BusinessConfig.vue',
  'admin-web/src/views/Technicians.vue',
  'admin-web/src/views/Commissions.vue',
  'admin-web/src/views/RestManagement.vue',
  'admin-web/src/views/Customers.vue',
  'cloudfunctions/admin/index.js',
  'cloudfunctions/login/index.js',
  'cloudfunctions/verifyAppointment/index.js',
  'cloudfunctions/getAppointments/index.js',
  'cloudfunctions/createAppointment/index.js',
  'cloudfunctions/getAvailableSlots/index.js',
  'cloudfunctions/getMyAppointments/index.js',
  'cloudfunctions/checkAvailability/index.js'
]

function stripComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

test('owned shipped/runtime content uses business-consulting copy only', () => {
  const forbidden = /中医|医疗|门诊|诊疗|治疗|患者|医师|针灸|推拿|理疗|康复|养生|调理|壹心堂/
  const offenders = []

  BRANDING_SCAN_FILES.forEach(relativePath => {
    const source = stripComments(fs.readFileSync(path.join(root, relativePath), 'utf8'))
    const match = source.match(forbidden)
    if (match) {
      offenders.push(`${relativePath}: ${match[0]}`)
    }
  })

  assert.deepEqual(offenders, [], `forbidden user-visible/default concepts found: ${offenders.join('; ')}`)
})

test('public article policy blocks drafts, old branding, and restricted content', () => {
  const listPolicy = require(path.join(root, 'cloudfunctions/getArticles/articlePolicy.js'))
  const detailPolicy = require(path.join(root, 'cloudfunctions/getArticleDetail/articlePolicy.js'))
  const adminPolicy = require(path.join(root, 'cloudfunctions/admin/articlePolicy.js'))
  const safeArticle = {
    status: 'published',
    title: '企业经营交流说明',
    summary: '介绍预约准备与到店安排',
    content: '<p>请提前整理企业基本情况和沟通需求。</p>'
  }
  const restrictedArticles = [
    { ...safeArticle, title: '壹心堂服务介绍' },
    { ...safeArticle, summary: '中医门诊预约说明' },
    { ...safeArticle, content: '<p>提供针灸与调理服务</p>' }
  ]

  assert.equal(listPolicy.isPublicBusinessArticle(safeArticle), true)
  assert.equal(detailPolicy.isPublicBusinessArticle(safeArticle), true)
  assert.equal(listPolicy.isPublicBusinessArticle({ ...safeArticle, status: 'draft' }), false)
  restrictedArticles.forEach(article => {
    assert.equal(listPolicy.isPublicBusinessArticle(article), false)
    assert.equal(detailPolicy.isPublicBusinessArticle(article), false)
    assert.equal(adminPolicy.hasRestrictedPublicContent(article), true)
  })
})

test('admin service deletion is wired through permission, API, UI, and cloud action', () => {
  const files = [
    'cloudfunctions/admin/index.js',
    'admin-web/src/utils/permissions.js',
    'admin-web/src/api/index.js',
    'admin-web/src/views/Services.vue'
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8'))

  files.forEach(source => assert.match(source, /deleteService/))
})

test('mini-program title and home technical footer use approved copy', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
  const indexConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/pages/index/index.json'), 'utf8'))
  const indexView = fs.readFileSync(path.join(root, 'miniprogram/pages/index/index.wxml'), 'utf8')

  assert.equal(appConfig.window.navigationBarTitleText, '营生预约')
  assert.equal(indexConfig.navigationStyle, 'custom')
  assert.equal(Object.hasOwn(indexConfig, 'navigationBarTitleText'), false)
  assert.doesNotMatch(indexView, /store-switcher-shell|store-picker/)
  assert.match(indexView, /技术由营生科贸提供/)
})

test('production privacy, content security, and account deletion are wired', () => {
  const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
  const loginConfig = JSON.parse(read('cloudfunctions/login/config.json'))
  const loginSource = read('cloudfunctions/login/index.js')
  const loginPage = read('miniprogram/pages/login/login.js')
  const minePage = read('miniprogram/pages/mine/mine.js')

  assert.match(loginPage, /wx\.openPrivacyContract/)
  assert.match(minePage, /wx\.openPrivacyContract/)
  assert.match(loginSource, /security\.msgSecCheck/)
  assert.match(loginSource, /security\.imgSecCheck/)
  assert.match(loginSource, /type === 'deleteAccount'/)
  assert.match(minePage, /handleDeleteAccount/)
  assert.equal(loginConfig.permissions.openapi.includes('security.imgSecCheck'), true)
  assert.equal(loginConfig.permissions.openapi.includes('security.msgSecCheck'), true)
})

test('production deployment manifest and cloud permissions are complete', () => {
  const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
  const cloudbaseConfig = JSON.parse(read('cloudbaserc.json'))
  const projectConfig = JSON.parse(read('project.config.json'))
  const configuredFunctions = new Set(cloudbaseConfig.functions.map(item => item.name))
  const expectedFunctions = [
    'admin', 'login', 'getServices', 'getAvailableSlots', 'checkAvailability',
    'createAppointment', 'cancelAppointment', 'verifyAppointment', 'getAppointments',
    'getMyAppointments', 'getArticles', 'getArticleDetail', 'sendReminder'
  ]
  const functionDirectories = fs.readdirSync(path.join(root, 'cloudfunctions'))
    .filter(name => fs.existsSync(path.join(root, 'cloudfunctions', name, 'index.js')))

  assert.deepEqual(functionDirectories.sort(), [...expectedFunctions].sort())
  assert.deepEqual([...configuredFunctions].sort(), [...expectedFunctions].sort())
  ;['createAppointment', 'cancelAppointment', 'verifyAppointment', 'sendReminder'].forEach(name => {
    const config = JSON.parse(read(`cloudfunctions/${name}/config.json`))
    assert.equal(config.permissions.openapi.includes('subscribeMessage.send'), true)
  })
  assert.equal(projectConfig.setting.urlCheck, true)
  assert.equal(projectConfig.setting.autoAudits, true)
  assert.equal(projectConfig.setting.uploadWithSourceMap, false)
  assert.match(read('cloudfunctions/admin/index.js'), /appointment\.patient_openid !== OPENID/)
})

test('release manifests pin the supported runtime, phone permission, and admin timeout', () => {
  const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
  const adminPackage = readJson('admin-web/package.json')
  const adminLock = readJson('admin-web/package-lock.json')
  const rootPackage = adminLock.packages['']
  const minimumNode = String(adminPackage.engines && adminPackage.engines.node).match(/>=\s*(\d+)\.(\d+)\.(\d+)/)
  const rootCloudbase = readJson('cloudbaserc.json')
  const embeddedAdminCloudbase = readJson('cloudfunctions/admin/cloudbaserc.json')
  const rootAdmin = rootCloudbase.functions.find(item => item.name === 'admin')
  const embeddedAdmin = embeddedAdminCloudbase.functions.find(item => item.name === 'admin')

  assert.ok(minimumNode, 'admin-web engines.node must declare a >= version')
  assert.deepEqual(minimumNode.slice(1).map(Number), [20, 19, 0])
  assert.deepEqual(
    {
      name: rootPackage.name,
      version: rootPackage.version,
      engines: rootPackage.engines,
      dependencies: rootPackage.dependencies,
      devDependencies: rootPackage.devDependencies
    },
    {
      name: adminPackage.name,
      version: adminPackage.version,
      engines: adminPackage.engines,
      dependencies: adminPackage.dependencies,
      devDependencies: adminPackage.devDependencies
    }
  )
  assert.equal(adminLock.name, adminPackage.name)
  assert.equal(readJson('cloudfunctions/login/config.json').permissions.openapi.includes('phonenumber.getPhoneNumber'), true)
  assert.deepEqual([...new Set(rootCloudbase.functions.map(item => item.runtime))], ['Nodejs18.15'])
  assert.deepEqual(embeddedAdminCloudbase.functions, [rootAdmin])
  rootCloudbase.functions.forEach(({ name }) => {
    const manifest = readJson(`cloudfunctions/${name}/package.json`)
    const lock = readJson(`cloudfunctions/${name}/package-lock.json`)

    assert.equal(manifest.dependencies['wx-server-sdk'], '4.0.2')
    assert.equal(lock.packages[''].dependencies['wx-server-sdk'], '4.0.2')
    assert.equal(lock.packages['node_modules/wx-server-sdk'].version, '4.0.2')
  })
})

test('admin entry prevents indexing and limits referrer leakage', () => {
  const html = fs.readFileSync(path.join(root, 'admin-web/index.html'), 'utf8')

  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/)
  assert.match(html, /<meta name="referrer" content="strict-origin-when-cross-origin">/)
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="base-uri 'self'; object-src 'none'; form-action 'self'">/)
})
