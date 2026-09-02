const FORBIDDEN_TERMS = [
  /中医|壹心堂|医疗|门诊|诊疗|治疗|疗效|治愈|理疗|针灸|推拿|艾灸|刮痧|养生|保健|健康|康复|体质|症状|药膳|健康管理/,
  /案例|客户案例|用户评价|口碑|真实病例|疗效承诺|效果保证|保证提高/,
  /承诺|保证/,
  /虚构|成功案例|成交量|客户数量|疗程/
]

const PRODUCTION_SEED_VERSION = 1

const BASE_SEED = Object.freeze({
  services: Object.freeze([
    Object.freeze({
      name: '企业信息登记与需求梳理',
      duration: 30,
      price: 3000,
      default_commission: 0,
      sort_order: 1,
      status: 'active',
      description: '现场确认公司基本信息与业务诉求，形成沟通记录，便于后续流程衔接。'
    }),
    Object.freeze({
      name: '到店咨询与服务项对接',
      duration: 45,
      price: 4800,
      default_commission: 0,
      sort_order: 2,
      status: 'active',
      description: '按预约时间进行到店接待，明确服务范围、办理节点与后续安排。'
    }),
    Object.freeze({
      name: '资料整理与流程协同服务',
      duration: 60,
      price: 6800,
      default_commission: 0,
      sort_order: 3,
      status: 'active',
      description: '协助梳理所需材料清单，对提交资料进行整理归档并给出补充提示。'
    }),
    Object.freeze({
      name: '服务方案确认与交接',
      duration: 90,
      price: 9600,
      default_commission: 0,
      sort_order: 4,
      status: 'active',
      description: '确认服务清单、办理顺序与联系方式，明确后续协同安排。'
    })
  ]),
  articles: Object.freeze([
    Object.freeze({
      title: '企业信息登记前的准备事项',
      summary: '提前梳理企业资料与联系人信息，现场沟通可更顺畅。',
      content: '<p>为提升到店效率，请提前准备联系人姓名、联系电话、企业名称及相关资料清单，便于第一时间完成登记与确认。</p><p>如遇资料缺失，可根据工作人员说明补充准备，避免重复往返。</p>',
      sort_order: 1,
      status: 'published'
    }),
    Object.freeze({
      title: '到店流程说明',
      summary: '包含接待、确认、资料核对与流程交付的标准节奏。',
      content: '<p>到店后先完成身份与预约信息确认，随后由工作人员进行服务说明。期间如有临时变动，请与现场人员同步时间与联系人。</p><p>所有关键节点以小程序中的预约记录为准。</p>',
      sort_order: 2,
      status: 'published'
    }),
    Object.freeze({
      title: '预约变更与取消说明',
      summary: '如需调整，可在我的预约中处理，避免占用其他客户时段。',
      content: '<p>若无法按时到场，请及时在小程序“我的预约”中取消并重新预约。</p><p>我们将根据取消与调度情况为您推荐可用时段。</p>',
      sort_order: 3,
      status: 'published'
    })
  ]),
  announcement: Object.freeze({
    enabled: true,
    title: '到店与咨询提示',
    content: '为提升服务秩序，建议到店前15分钟确认预约；如需调整，请在预约记录中取消后重新预约。',
    sort: 1
  }),
  facilities: Object.freeze([
    Object.freeze({
      name: '门口停车位',
      icon: 'logistics',
      enabled: true,
      sort: 1
    }),
    Object.freeze({
      name: '等候休息区',
      icon: 'friends-o',
      enabled: true,
      sort: 2
    }),
    Object.freeze({
      name: '资料预审指引',
      icon: 'records-o',
      enabled: true,
      sort: 3
    }),
    Object.freeze({
      name: '到店导航指引',
      icon: 'location-o',
      enabled: true,
      sort: 4
    }),
    Object.freeze({
      name: '前台咨询接待区',
      icon: 'shop-o',
      enabled: true,
      sort: 5
    })
  ])
})

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function buildProductionSeed() {
  return deepClone(BASE_SEED)
}

function ensureNoForbiddenTerms(seed = {}) {
  const allText = [
    ...((seed.services || []).map(item => `${item.name} ${item.description}`)),
    ...((seed.articles || []).map(item => `${item.title} ${item.summary} ${item.content}`)),
    `${seed.announcement && seed.announcement.title ? seed.announcement.title : ''} ${seed.announcement && seed.announcement.content ? seed.announcement.content : ''}`,
    ...((seed.facilities || []).map(item => item.name))
  ].join(' ')
  return !FORBIDDEN_TERMS.some(item => item.test(allText))
}

module.exports = {
  PRODUCTION_SEED_VERSION,
  buildProductionSeed,
  ensureNoForbiddenTerms
}
