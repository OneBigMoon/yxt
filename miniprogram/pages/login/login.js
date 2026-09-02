const { fullLogin, checkAuth } = require('../../utils/auth')

Page({
  data: {
    agreed: false,
    loginLoading: false
  },

  onLoad() {
    checkAuth({ refresh: true }).then(userInfo => {
      if (userInfo) {
        this.routeByRole(userInfo.role)
      }
    })
  },

  onAgreementTap() {
    this.setData({ agreed: !this.data.agreed })
  },

  async onGetPhoneNumber(e) {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先勾选同意协议', icon: 'none' })
      return
    }

    if (this.data.loginLoading) {
      return
    }

    if (e.detail.errMsg !== 'getPhoneNumber:ok') {
      wx.showToast({ title: '需要手机号用于预约确认', icon: 'none' })
      return
    }

    this.setData({ loginLoading: true })

    try {
      const result = await fullLogin(null, e.detail.code)

      // 黑名单检查
      if (result.is_blacklisted) {
        this.setData({ loginLoading: false })
        wx.showModal({
          title: '账号异常',
          content: '该账号暂无法预约，请联系门店处理',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }

      const toastTitle = result.role === 'technician'
        ? '工作人员身份已识别'
        : (result.isNewUser ? '用户档案已建立' : '登录成功')

      wx.showToast({ title: toastTitle, icon: 'success' })
      setTimeout(() => {
        this.routeByRole(result.role)
      }, 1000)
    } catch (err) {
      console.error('登录失败:', err)
      wx.showToast({
        title: err && err.message ? err.message : '登录失败，请重试',
        icon: 'none'
      })
      this.setData({ loginLoading: false })
    }
  },

  routeByRole(role) {
    if (role === 'technician') {
      wx.redirectTo({ url: '/pages/tech-home/tech-home' })
    } else {
      wx.switchTab({ url: '/pages/index/index' })
    }
  },

  showAgreement() {
    wx.showModal({
      title: '用户协议',
      content: '运营主体：山东营生科贸有限公司。\n1. 本小程序提供企业服务信息展示与预约登记。\n2. 用户应提供真实、准确的预约信息，并按约定时间到店。\n3. 如需变更或取消预约，请提前在预约记录中操作。\n4. 具体服务内容、时间及费用以预约页面和门店确认为准。',
      showCancel: false
    })
  },

  showPrivacy() {
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
  }
})
