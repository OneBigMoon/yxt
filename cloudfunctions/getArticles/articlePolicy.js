const RESTRICTED_PUBLIC_CONTENT = /一心堂|壹心堂|中医|医疗|门诊|诊疗|治疗|疗效|治愈|处方|疾病|患者|康复|理疗|针灸|推拿|按摩|拔罐|艾灸|刮痧|药膳|养生|调理|保健|体质|症状|健康管理/

function normalizeArticleText(article = {}) {
  return [article.title, article.summary, article.content]
    .map(value => String(value || ''))
    .join(' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp|#160);/gi, '')
    .replace(/\s+/g, '')
}

function hasRestrictedPublicContent(article) {
  return RESTRICTED_PUBLIC_CONTENT.test(normalizeArticleText(article))
}

function isPublicBusinessArticle(article) {
  return Boolean(article && article.status === 'published' && !hasRestrictedPublicContent(article))
}

module.exports = {
  hasRestrictedPublicContent,
  isPublicBusinessArticle
}
