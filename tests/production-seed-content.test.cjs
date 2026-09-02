const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildProductionSeed,
  PRODUCTION_SEED_VERSION
} = require('../cloudfunctions/admin/productionSeed')

const FORBIDDEN_PATTERNS = [
  /中医|壹心堂|医疗|门诊|诊疗|治疗|疗效|治愈|理疗|针灸|推拿|艾灸|刮痧|药膳|养生|保健|健康|康复|症状|体质/,
  /客户案例|用户评价|虚构|承诺|保证|提高?效果|疗效|成功案例|成交量|客户数量|客户评价/,
  /治愈率|恢复率|承诺达成|疗效显著/
]

function assertNoForbiddenText(text, pathLabel) {
  const normalized = String(text || '')
  FORBIDDEN_PATTERNS.forEach(pattern => {
    assert.equal(pattern.test(normalized), false, `${pathLabel} contains forbidden phrase: ${pattern}`)
  })
}

function sanitizeServiceText(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, '')
}

test('production seed has complete safe business content', () => {
  const seed = buildProductionSeed()

  assert.equal(Array.isArray(seed.services), true)
  assert.equal(seed.services.length, 4)
  assert.equal(Array.isArray(seed.articles), true)
  assert.equal(seed.articles.length, 3)
  assert.equal(Array.isArray(seed.facilities), true)
  assert.equal(seed.facilities.length >= 4, true)
  assert.equal(seed.announcement && seed.announcement.enabled, true)
  assert.equal(typeof PRODUCTION_SEED_VERSION, 'number')
  assert.equal(PRODUCTION_SEED_VERSION > 0, true)
})

test('production seed services meet schema and safe content', () => {
  const seed = buildProductionSeed()

  seed.services.forEach((service, index) => {
    assert.equal(typeof service.name, 'string')
    assert.equal(service.name.trim().length > 0, true)
    assert.equal(service.status, 'active')
    assert.equal(Number.isInteger(service.sort_order), true)
    assert.equal(service.sort_order >= 1, true)
    assert.equal(Number.isInteger(service.duration), true)
    assert.equal(service.duration >= 15 && service.duration <= 120, true)
    assert.equal(Number.isInteger(service.price), true)
    assert.equal(service.price >= 0, true)
    assert.equal(Number.isInteger(service.default_commission), true)
    assert.equal(service.default_commission, 0)
    assert.equal(typeof service.description, 'string')
    assert.equal(sanitizeServiceText(service.description).length > 0, true)
    assertNoForbiddenText(`${service.name} ${service.description}`, `services[${index}]`)
  })
})

test('production seed articles are publishable and content-safe', () => {
  const seed = buildProductionSeed()

  seed.articles.forEach((article, index) => {
    assert.equal(typeof article.title, 'string')
    assert.equal(article.title.trim().length > 0, true)
    assert.equal(typeof article.summary, 'string')
    assert.equal(article.summary.trim().length > 0, true)
    assert.equal(typeof article.content, 'string')
    assert.equal(article.content.trim().length > 0, true)
    assert.equal(Number.isInteger(article.sort_order), true)
    assert.equal(article.sort_order >= 1, true)
    assert.equal(article.status, 'published')
    assertNoForbiddenText(`${article.title} ${article.summary} ${article.content}`, `articles[${index}]`)
  })
})

test('production seed announcement and facilities are suitable defaults', () => {
  const seed = buildProductionSeed()

  assert.equal(seed.announcement.title.trim().length > 0, true)
  assert.equal(seed.announcement.content.trim().length > 0, true)
  assert.equal(typeof seed.announcement.sort, 'number')
  assert.equal(Number.isInteger(seed.announcement.sort), true)
  assert.equal(seed.announcement.enabled, true)
  assertNoForbiddenText(`${seed.announcement.title} ${seed.announcement.content}`, 'announcement')

  const iconList = new Set(['logistics', 'friends-o', 'records-o', 'shop-o', 'location-o'])
  seed.facilities.forEach((facility, index) => {
    assert.equal(typeof facility.name, 'string')
    assert.equal(facility.name.trim().length > 0, true)
    assert.equal(typeof facility.icon, 'string')
    assert.equal(iconList.has(facility.icon), true, `facilities[${index}].icon invalid: ${facility.icon}`)
    assert.equal(facility.enabled, true)
    assert.equal(Number.isInteger(facility.sort), true)
    assert.equal(facility.sort >= 1, true)
    assertNoForbiddenText(facility.name, `facilities[${index}]`)
  })
})

test('buildProductionSeed returns deep clone and immutable seed contract', () => {
  const first = buildProductionSeed()
  const second = buildProductionSeed()

  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.services, second.services)
  assert.notStrictEqual(first.services[0], second.services[0])
  assert.notStrictEqual(first.articles, second.articles)
  assert.notStrictEqual(first.announcement, second.announcement)

  first.services[0].name = '测试变更'
  first.articles[0].title = '测试变更'
  first.facilities[0].name = '测试变更'

  assert.notEqual(second.services[0].name, '测试变更')
  assert.notEqual(second.articles[0].title, '测试变更')
  assert.notEqual(second.facilities[0].name, '测试变更')
})
