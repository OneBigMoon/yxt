const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const { isPublicBusinessArticle } = require('./articlePolicy')

exports.main = async (event, context) => {
  const { id } = event

  try {
    if (!id) {
      return { code: -1, message: '缺少文章ID' }
    }

    const res = await db.collection('articles')
      .doc(id)
      .get()

    if (!isPublicBusinessArticle(res.data)) {
      return { code: -1, message: '文章不存在或已下架' }
    }

    // 转换 cloud:// 封面图为 https
    const coverUrl = res.data.cover_image || res.data.coverUrl
    let coverImage = coverUrl || ''
    if (coverUrl && coverUrl.startsWith('cloud://')) {
      try {
        const urlRes = await cloud.getTempFileURL({ fileList: [coverUrl] })
        if (urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) {
          coverImage = urlRes.fileList[0].tempFileURL
        }
      } catch (e) {
        console.error('转换封面图链接失败:', e.message)
      }
    }

    const article = {
      ...res.data,
      cover_image: coverImage,
      created_at: formatDate(res.data.created_at || res.data.createdAt)
    }

    return { code: 0, data: article }
  } catch (err) {
    console.error('获取文章详情失败:', err)
    return { code: -1, message: '获取文章详情失败，请稍后重试' }
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
