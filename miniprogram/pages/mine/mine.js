const { getConfig } = require('../../utils/api')
const { checkAuth, logout, checkBlacklist, deleteAccount } = require('../../utils/auth')

Page({
  data: {
    userInfo: {},
    isLoggedIn: false,
    clinicInfo: {},
    businessHourLines: [],
    maskedPhone: '',
    userDisplayName: '',
    facilities: []
  },

  onLoad() {
    this.loadConfig()
  },

  onShow() {
    this.loadUserInfo()
  },

  loadUserInfo() {
    checkAuth({ refresh: true }).then(userInfo => {
      if (userInfo) {
        const maskedPhone = this.maskPhone(userInfo.phone)
        const hasCustomName = userInfo.nick_name && userInfo.nick_name !== '微信用户'
        const userDisplayName = hasCustomName ? userInfo.nick_name : (maskedPhone || '已登录')
        this.setData({ userInfo, isLoggedIn: true, maskedPhone, userDisplayName })

        // 实时检查黑名单状态
        this.checkBlacklistStatus()
      } else {
        this.setData({ userInfo: {}, isLoggedIn: false, maskedPhone: '', userDisplayName: '' })
      }
    })
  },

  maskPhone(phone) {
    if (phone && phone.length === 11) {
      return phone.substring(0, 3) + '****' + phone.substring(7)
    }
    return phone || ''
  },

  async checkBlacklistStatus() {
    try {
      const isBlacklisted = await checkBlacklist()
      if (isBlacklisted) {
        wx.showModal({
          title: '账号异常',
          content: '该账号暂无法预约，请联系门店处理',
          showCancel: false,
          confirmText: '知道了',
          success: () => {
            logout()
            this.setData({ userInfo: {}, isLoggedIn: false, maskedPhone: '', userDisplayName: '' })
          }
        })
      }
    } catch (err) {
      // 检查失败不影响正常使用
    }
  },

  async loadConfig() {
    try {
      const config = await getConfig()
      const storeInfo = config.store || {}
      const businessHourLines = []
      if (config.schedule) {
        const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
        const periods = []
        for (let day = 1; day <= 7; day++) {
          const hours = config.schedule[day]
          if (Array.isArray(hours) && hours.length > 0) {
            const times = hours.map(p => `${p.start}-${p.end}`).join('、')
            periods.push(`${dayNames[day]} ${times}`)
            businessHourLines.push({ day: dayNames[day], time: times })
          }
        }
        if (periods.length > 0) {
          storeInfo.business_hours = periods.join('；')
        }
      }
      this.setData({
        clinicInfo: storeInfo,
        businessHourLines,
        facilities: this.normalizeFacilities(config.facilities)
      })
    } catch (err) {
      console.error('获取配置失败:', err)
      wx.showToast({ title: '获取门店信息失败', icon: 'none' })
    }
  },

  normalizeFacilities(items) {
    const fallback = [
      { name: '门口停车', icon: 'logistics', enabled: true, sort: 1 },
      { name: '等候座椅', icon: 'friends-o', enabled: true, sort: 2 },
      { name: '资料预审指引', icon: 'records-o', enabled: true, sort: 3 }
    ]
    const source = Array.isArray(items) ? items : fallback
    return source
      .filter(item => item && item.enabled !== false && item.name)
      .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
      .map(item => ({
        name: String(item.name || '').trim(),
        icon: String(item.icon || 'shop-o').trim()
      }))
      .slice(0, 6)
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' })
  },

  handleUserTap() {
    if (this.data.isLoggedIn) {
      this.goProfile()
    } else {
      this.goLogin()
    }
  },

  goProfile() {
    if (!this.data.isLoggedIn) {
      this.goLogin()
      return
    }
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  goBooking() {
    wx.switchTab({ url: '/pages/booking/booking' })
  },

  goMyAppointments() {
    wx.navigateTo({ url: '/pages/my-appointments/my-appointments' })
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


  showUserAgreement() {
    wx.showModal({
      title: '用户协议',
      content: '运营主体：山东营生科贸有限公司。\n1. 本小程序提供企业服务信息展示与预约登记。\n2. 用户应提供真实、准确的预约信息，并按约定时间到店。\n3. 如需变更或取消预约，请提前在预约记录中操作。\n4. 具体服务内容、时间及费用以预约页面和门店确认为准。',
      showCancel: false
    })
  },

  showPrivacyContract() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({
        fail: () => this.showPrivacyFallback()
      })
      return
    }
    this.showPrivacyFallback()
  },

  showPrivacyFallback() {
    wx.showModal({
      title: '隐私保护说明',
      content: '运营主体：山东营生科贸有限公司。\n1. 本预约服务小程序仅处理完成登录和预约所必需的手机号、预约记录，以及您自愿填写的昵称和头像。\n2. 手机号用于身份识别、预约确认、到店联系和预约核销。\n3. 工作人员扫码核销时可使用相机或相册选择二维码，仅识别用于核销的二维码内容；门店导航仅打开已配置的门店坐标，不会持续读取您的位置。\n4. 我们依法采取安全措施保存信息，并在实现服务目的所需期限内保留。\n5. 您可通过首页已配置的“联系门店”申请查询、更正或删除个人信息，也可在“我的”中提交注销。',
      showCancel: false
    })
  },

  handleLogout() {
    wx.showModal({
      title: '提示',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          logout()
          this.setData({ userInfo: {}, isLoggedIn: false, maskedPhone: '', userDisplayName: '' })
          wx.showToast({ title: '已退出登录', icon: 'success' })
        }
      }
    })
  },

  handleDeleteAccount() {
    wx.showModal({
      title: '注销账号',
      content: '注销后将删除手机号、昵称和头像，并匿名化历史预约。该操作不可恢复，是否继续？',
      confirmText: '确认注销',
      confirmColor: '#c45656',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '正在注销...' })
        try {
          await deleteAccount()
          wx.hideLoading()
          this.setData({ userInfo: {}, isLoggedIn: false, maskedPhone: '', userDisplayName: '' })
          wx.showToast({ title: '账号已注销', icon: 'success' })
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '注销失败，请重试', icon: 'none' })
        }
      }
    })
  }
})
