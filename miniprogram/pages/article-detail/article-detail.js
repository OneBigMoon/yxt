const { getArticleDetail } = require('../../utils/api')

const mergeTagStyle = (tag, extraStyle) => {
  if (/style\s*=/.test(tag)) {
    return tag.replace(/style\s*=\s*(['"])(.*?)\1/i, (_, quote, style) => {
      return `style=${quote}${style};${extraStyle}${quote}`
    })
  }

  return tag.replace(/\s*\/?>$/, (ending) => {
    return ` style="${extraStyle}"${ending.includes('/') ? ' /' : ''}>`
  })
}

const appendNodeStyle = (attrs = {}, extraStyle) => ({
  ...attrs,
  style: `${attrs.style ? `${attrs.style};` : ''}${extraStyle}`
})

const normalizeArticleContent = (content) => {
  const imageStyle = 'max-width:100%;height:auto;display:block;margin:12px auto;box-sizing:border-box;'
  const blockStyle = 'max-width:100%;box-sizing:border-box;word-break:break-word;overflow-wrap:anywhere;'
  const tableStyle = 'width:100%;max-width:100%;table-layout:fixed;word-break:break-word;'

  if (typeof content === 'string') {
    return content
      .replace(/<img\b[^>]*>/gi, tag => mergeTagStyle(tag, imageStyle))
      .replace(/<table\b[^>]*>/gi, tag => mergeTagStyle(tag, tableStyle))
      .replace(/<(td|th)\b[^>]*>/gi, tag => mergeTagStyle(tag, blockStyle))
      .replace(/<(p|div|section)\b[^>]*>/gi, tag => mergeTagStyle(tag, blockStyle))
  }

  if (!Array.isArray(content)) {
    return content
  }

  return content.map((node) => {
    const name = String(node.name || '').toLowerCase()
    const extraStyle = name === 'img'
      ? imageStyle
      : (name === 'table' ? tableStyle : (['td', 'th', 'p', 'div', 'section'].includes(name) ? blockStyle : ''))

    return {
      ...node,
      attrs: extraStyle ? appendNodeStyle(node.attrs, extraStyle) : node.attrs,
      children: Array.isArray(node.children) ? normalizeArticleContent(node.children) : node.children
    }
  })
}

Page({
  data: {
    article: {},
    loading: true
  },

  onLoad(options) {
    if (!options.id) {
      wx.showToast({ title: '文章不存在', icon: 'none' })
      setTimeout(() => {
        wx.navigateBack()
      }, 1500)
      return
    }
    this.loadArticle(options.id)
  },

  async loadArticle(id) {
    this.setData({ loading: true })

    try {
      const article = await getArticleDetail(id)
      this.setData({
        article: article ? {
          ...article,
          content: normalizeArticleContent(article.content)
        } : {},
        loading: false
      })
    } catch (err) {
      console.error('获取文章详情失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  }
})
