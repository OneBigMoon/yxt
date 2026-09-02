const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  try {
    const res = await db.collection('services')
      .where({
        status: 'active'
      })
      .orderBy('sort_order', 'asc')
      .get()

    // 转换 cloud:// 图片链接为 https 临时链接
    const cloudIds = res.data
      .map(s => s.image_url || s.imageUrl)
      .filter(u => u && u.startsWith('cloud://'))

    if (cloudIds.length > 0) {
      try {
        const urlRes = await cloud.getTempFileURL({ fileList: cloudIds })
        const urlMap = {}
        urlRes.fileList.forEach(f => { urlMap[f.fileID] = f.tempFileURL })
        res.data.forEach(s => {
          const key = s.image_url || s.imageUrl
          if (key && urlMap[key]) {
            s.image_url = urlMap[key]
          }
        })
      } catch (e) {
        console.error('转换图片链接失败:', e.message)
      }
    }

    const data = res.data.map(service => ({
      _id: service._id,
      name: service.name,
      description: service.description,
      duration: service.duration,
      image_url: service.image_url || service.imageUrl || ''
    }))

    return { code: 0, data }
  } catch (err) {
    console.error('获取服务列表失败:', err)
    return { code: -1, message: '获取服务列表失败，请稍后重试' }
  }
}
