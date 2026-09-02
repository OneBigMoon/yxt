const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const { isPublicBusinessArticle } = require('./articlePolicy')

exports.main = async (event, context) => {
  try {
    const page = Math.max(1, Number(event.page) || 1)
    const pageSize = Math.min(10, Math.max(1, Number(event.pageSize) || 3))
    const res = await db.collection('articles')
      .where({ status: 'published' })
      .orderBy('sort_order', 'asc')
      .skip((page - 1) * pageSize)
      .limit(pageSize + 1)
      .get()

    const filteredArticles = (res.data || []).filter(isPublicBusinessArticle)
    const hasMore = filteredArticles.length > pageSize
    const publicArticles = filteredArticles.slice(0, pageSize)

    // 转换 cloud:// 封面图为 https
    const cloudIds = publicArticles
      .map(a => a.cover_image || a.coverUrl)
      .filter(u => u && u.startsWith('cloud://'))

    if (cloudIds.length > 0) {
      try {
        const urlRes = await cloud.getTempFileURL({ fileList: cloudIds })
        const urlMap = {}
        urlRes.fileList.forEach(f => { urlMap[f.fileID] = f.tempFileURL })
        publicArticles.forEach(a => {
          const key = a.cover_image || a.coverUrl
          if (key && urlMap[key]) {
            a.cover_image = urlMap[key]
          }
        })
      } catch (e) {
        console.error('转换封面图链接失败:', e.message)
      }
    }

    const articles = publicArticles.map(article => ({
      ...article,
      cover_image: article.cover_image || article.coverUrl || '',
      created_at: formatDate(article.created_at || article.createdAt)
    }))

    return { code: 0, data: { list: articles, hasMore } }
  } catch (err) {
    console.error('获取文章列表失败:', err)
    return { code: -1, message: '获取文章列表失败，请稍后重试' }
  }
}

function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
