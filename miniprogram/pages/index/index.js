const { getArticles, getConfig, getHolidays, checkAvailability, getServices } = require('../../utils/api')

Page({
  data: {
    clinicInfo: {},
    closureNotice: '',
    articles: [],
    articlePage: 1,
    articlePageSize: 3,
    articleHasMore: true,
    articleLoadingMore: false,
    loading: true,
    businessHourLines: [],
    businessStatusCards: [],
    homeModules: [],
    announcement: {},
    recommendedTechnicians: [],
    recommendedServices: [],
    facilities: []
  },

  onLoad() {
    // 首次加载由 onShow 处理
  },

  onShow() {
    this.loadData().catch((err) => {
      console.error('[首页] onShow 触发 loadData 失败:', err)
    })
  },

  onPullDownRefresh() {
    this.loadData().then(() => {
      wx.stopPullDownRefresh()
    }).catch((err) => {
      wx.stopPullDownRefresh()
      console.error('[首页] 下拉刷新 loadData 失败:', err)
    })
  },

  onReachBottom() {
    this.loadMoreArticles()
  },

  async loadData() {
    this.setData({ loading: true, closureNotice: '' })
    let config = {}
    let articles = []
    let articleHasMore = false
    let holidays = []

    try {
      config = await this.loadConfig()

      const homeModules = this.normalizeHomeModules(config)
      const moduleState = homeModules.reduce((state, item) => ({ ...state, [item.key]: item.enabled }), {})

      const articleResult = moduleState.articles ? await this.loadArticles(1) : { list: [], hasMore: false }
      articles = articleResult.list
      articleHasMore = articleResult.hasMore
      const services = moduleState.recommended_services ? await this.loadServices() : []

      holidays = await this.loadHolidays()

      const availability = await this.loadAvailability()

      let closureNotice = ''
      const today = this.formatDate(new Date())
      const todayHoliday = (holidays || []).find(h => h.date === today && h.type === 'closure')
      if (todayHoliday) {
        const nextDay = this.getNextBusinessDay(config, holidays)
        closureNotice = todayHoliday.reason
          ? `今日停业：${todayHoliday.reason}，预计${nextDay}恢复营业`
          : `今日停业，预计${nextDay}恢复营业`
      }

      const storeSelection = this.buildStoreSelection(config)
      const storeInfo = storeSelection.currentStore
      this.setData({
        clinicInfo: storeInfo,
        closureNotice,
      articles: articles || [],
      articlePage: 1,
        articleHasMore,
        businessHourLines: storeInfo.businessHourLines || [],
        businessStatusCards: this.buildBusinessStatusCards(availability.dateStatus || {}),
        homeModules: homeModules.filter(item => item.enabled),
        announcement: this.normalizeAnnouncement(config.announcement),
        recommendedTechnicians: this.normalizeRecommendedTechnicians(config.recommended_technicians),
        recommendedServices: this.normalizeRecommendedServices(config.recommended_services, services),
        facilities: this.normalizeFacilities(config.facilities),
        loading: false
      })
    } catch (err) {
      console.error('加载数据失败:', err)
      this.setData({ loading: false, closureNotice: '' })
    }
  },

  async loadConfig() {
    try {
      const config = await getConfig()
      return config || {}
    } catch (err) {
      console.error('获取配置失败:', err)
      return {}
    }
  },

  async loadArticles(page = 1) {
    try {
      const result = await getArticles({ page, pageSize: this.data.articlePageSize })
      const list = Array.isArray(result)
        ? result
        : (Array.isArray(result && result.list) ? result.list : [])
      return {
        list,
        hasMore: Array.isArray(result)
          ? list.length >= this.data.articlePageSize
          : Boolean(result && result.hasMore)
      }
    } catch (err) {
      console.error('获取文章失败:', err)
      return { list: [], hasMore: false }
    }
  },

  async loadMoreArticles() {
    if (this.data.loading || this.data.articleLoadingMore || !this.data.articleHasMore) return

    const nextPage = this.data.articlePage + 1
    this.setData({ articleLoadingMore: true })
    try {
      const nextResult = await this.loadArticles(nextPage)
      const nextArticles = nextResult.list
      const existingIds = new Set(this.data.articles.map(item => item._id))
      const uniqueArticles = (nextArticles || []).filter(item => item && !existingIds.has(item._id))
      this.setData({
        articles: [...this.data.articles, ...uniqueArticles],
        articlePage: nextPage,
        articleHasMore: nextResult.hasMore
      })
    } finally {
      this.setData({ articleLoadingMore: false })
    }
  },

  async loadServices() {
    try {
      return await getServices()
    } catch (err) {
      console.error('获取推荐服务失败:', err)
      return []
    }
  },

  async loadHolidays() {
    try {
      return await getHolidays({ type: 'closure' })
    } catch (err) {
      console.error('获取停业日失败:', err)
      return []
    }
  },

  async loadAvailability() {
    try {
      return await checkAvailability()
    } catch (err) {
      console.error('获取营业状态失败:', err)
      return { dateStatus: {} }
    }
  },

  buildBusinessStatusCards(dateStatus) {
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(today.getDate() + 1)

    return [
      this.buildBusinessStatusCard('今日', today, dateStatus[this.formatDate(today)]),
      this.buildBusinessStatusCard('明日', tomorrow, dateStatus[this.formatDate(tomorrow)])
    ]
  },

  buildBusinessStatusCard(label, date, statusInfo) {
    const monthDay = `${date.getMonth() + 1}/${date.getDate()}`
    const status = statusInfo && statusInfo.status

    const statusMap = {
      available: { text: '营业可约', tone: 'open' },
      rest: { text: '休息', tone: 'closed' },
      closure: { text: '停业', tone: 'closed' },
      full: { text: '已约满', tone: 'busy' }
    }
    const display = statusMap[status] || { text: '营业待确认', tone: 'pending' }

    return {
      label,
      date: monthDay,
      text: display.text,
      tone: display.tone,
      iconColor: display.tone === 'open' ? '#5a7846' : '#7a6c66',
      reason: statusInfo && statusInfo.reason ? statusInfo.reason : ''
    }
  },

  getNextBusinessDay(config, holidays) {
    const today = new Date()
    for (let i = 1; i <= 30; i++) {
      const nextDay = new Date(today)
      nextDay.setDate(today.getDate() + i)
      const dateStr = this.formatDate(nextDay)
      const dayOfWeek = nextDay.getDay() || 7

      const isWorkDay = config.schedule && config.schedule[dayOfWeek] && config.schedule[dayOfWeek].length > 0
      const isHoliday = (holidays || []).some(h => h.date === dateStr)

      if (isWorkDay && !isHoliday) {
        return `${nextDay.getMonth() + 1}月${nextDay.getDate()}日`
      }
    }
    return '待定'
  },

  formatDate(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  },

  callStorePhone() {
    const phone = String(this.data.clinicInfo.phone || '').trim()
    if (phone) {
      wx.makePhoneCall({ phoneNumber: phone })
    }
  },

  openLocation() {
    const { clinicInfo } = this.data
    const configuredLatitude = Number(clinicInfo.latitude)
    const configuredLongitude = Number(clinicInfo.longitude)
    const hasConfiguredLocation = (
      Number.isFinite(configuredLatitude) &&
      Number.isFinite(configuredLongitude) &&
      configuredLatitude >= -90 &&
      configuredLatitude <= 90 &&
      configuredLongitude >= -180 &&
      configuredLongitude <= 180 &&
      configuredLatitude !== 0 &&
      configuredLongitude !== 0
    )
    if (!hasConfiguredLocation) {
      wx.showToast({ title: '暂无门店位置信息', icon: 'none' })
      return
    }

    wx.openLocation({
      latitude: configuredLatitude,
      longitude: configuredLongitude,
      scale: 18,
      name: clinicInfo.name || '山东营生科贸有限公司',
      address: String(clinicInfo.address || '').trim()
    })
  },

  normalizeHomeModules(config = {}) {
    const defaults = [
      { key: 'business_status', title: '营业状态', enabled: true, sort: 1 },
      { key: 'recommended_services', title: '推荐服务', enabled: true, sort: 2 },
      { key: 'recommended_technicians', title: '推荐顾问', enabled: true, sort: 3 },
      { key: 'articles', title: '企业资讯', enabled: true, sort: 999 }
    ]
    const configured = Array.isArray(config.modules) ? config.modules : []
    const legacy = Array.isArray(config.home_cards) ? config.home_cards : []
    return defaults.map(item => {
      const saved = configured.find(candidate => candidate && candidate.key === item.key)
      const legacyKey = item.key === 'articles' ? 'wellness_classroom' : item.key
      const legacySaved = legacy.find(candidate => candidate && candidate.key === legacyKey)
      const source = saved || legacySaved || {}
      return {
        ...item,
        title: String(source.title || item.title).slice(0, 24),
        enabled: source.enabled !== undefined ? source.enabled !== false : item.enabled,
        sort: item.key === 'articles' ? 999 : Number(source.sort || item.sort)
      }
    }).sort((a, b) => a.sort - b.sort)
  },

  normalizeAnnouncement(item) {
    if (!item || item.enabled === false || !String(item.content || '').trim()) return {}
    return {
      title: String(item.title || '公告').trim().slice(0, 24),
      content: String(item.content || '').trim().slice(0, 200)
    }
  },

  normalizeRecommendedServices(configured, services) {
    const available = Array.isArray(services) ? services : []
    const preferred = Array.isArray(configured) ? configured.filter(item => item && item.enabled !== false) : []
    const ordered = preferred.length > 0
      ? preferred.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0)).map(item => available.find(service => service._id === item.service_id)).filter(Boolean)
      : available
    return ordered.slice(0, 4).map(item => ({
      _id: item._id,
      name: String(item.name || '').trim(),
      description: String(item.description || '企业服务').trim(),
      duration: Number(item.duration || 0)
    }))
  },

  normalizeFacilities(items) {
    return (Array.isArray(items) ? items : [])
      .filter(item => item && item.enabled !== false && item.name)
      .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
      .slice(0, 8)
      .map(item => ({ name: String(item.name).slice(0, 16), icon: String(item.icon || 'shop-o').slice(0, 24) }))
  },

  normalizeRecommendedTechnicians(items) {
    const source = Array.isArray(items) ? items : []
    return source
      .filter(item => item && item.enabled !== false && item.name)
      .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
      .map(item => ({
        name: String(item.name || '').trim(),
        specialty: String(item.specialty || '擅长企业服务').trim()
      }))
      .slice(0, 4)
  },

  buildStoreSelection(config = {}) {
    const configuredStores = Array.isArray(config.stores) ? config.stores : []
    const source = configuredStores.length > 0
      ? configuredStores
      : [config.store || {}]
    const hasExplicitDefault = source.some(item => item && item.is_default === true)
    const stores = source
      .filter(item => item && typeof item === 'object')
      .map((item, index) => {
        const storeId = String(item.store_id || item._id || item.id || `store-${index + 1}`)
        const schedule = item.schedule || config.schedule || {}
        const businessHours = this.buildBusinessHours(schedule)
        return {
          ...item,
          storeId,
          isDefault: item.is_default === true || (!hasExplicitDefault && index === 0),
          business_hours: businessHours.text,
          businessHourLines: businessHours.lines
        }
      })

    if (stores.length === 0) {
      stores.push({
        storeId: 'store-1',
        name: '山东营生科贸有限公司',
        address: '',
        latitude: null,
        longitude: null,
        isDefault: true,
        business_hours: '',
        businessHourLines: []
      })
    }

    const savedStoreId = String(wx.getStorageSync('yxt_selected_store_id') || '')
    const currentStore = stores.find(item => item.storeId === savedStoreId) ||
      stores.find(item => item.isDefault) ||
      stores[0]

    return { stores, currentStore }
  },

  buildBusinessHours(schedule = {}) {
    const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const periods = []
    const lines = []
    for (let day = 1; day <= 7; day++) {
      const hours = schedule[day]
      if (Array.isArray(hours) && hours.length > 0) {
        const times = hours.map(period => `${period.start}-${period.end}`).join('、')
        periods.push(`${dayNames[day]} ${times}`)
        lines.push({ day: dayNames[day], time: times })
      }
    }
    return { text: periods.join('；'), lines }
  },

  goBooking() {
    wx.switchTab({
      url: '/pages/booking/booking'
    })
  },

  goMyAppointments() {
    wx.navigateTo({
      url: '/pages/my-appointments/my-appointments'
    })
  },

  onCoverError(e) {
    const index = e.currentTarget.dataset.index
    this.setData({
      [`articles[${index}].cover_image`]: '/images/default-article.png'
    })
  },

  viewArticle(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/article-detail/article-detail?id=${id}`
    })
  },

  viewArticles() {
    wx.showToast({ title: '暂无更多文章', icon: 'none' })
  },

})
