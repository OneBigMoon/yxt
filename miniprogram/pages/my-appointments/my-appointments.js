const { getMyAppointments } = require('../../utils/api')

Page({
  data: {
    activeTab: 'pending',
    appointments: [],
    loading: true
  },

  onLoad() {
    // 首次加载由 onShow 处理
  },

  onShow() {
    this.loadAppointments().catch((err) => {
      console.error('我的预约刷新失败:', err)
    })
  },

  onPullDownRefresh() {
    this.loadAppointments().then(() => {
      wx.stopPullDownRefresh()
    }).catch((err) => {
      wx.stopPullDownRefresh()
      console.error('我的预约下拉刷新失败:', err)
    })
  },

  async loadAppointments() {
    this.setData({ loading: true })
    try {
      const appointments = await getMyAppointments({
        status: this.data.activeTab
      })
      this.setData({
        appointments: appointments || [],
        loading: false
      })
    } catch (err) {
      console.error('获取预约列表失败:', err)
      this.setData({ loading: false })
    }
  },

  onTabChange(e) {
    this.setData({
      activeTab: e.detail,
      appointments: []
    })
    this.loadAppointments()
  },

  viewDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/appointment-detail/appointment-detail?id=${id}`
    })
  }
})
