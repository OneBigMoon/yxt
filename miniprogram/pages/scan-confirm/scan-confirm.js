Page({
  data: {
    sessionId: '',
    loading: false,
    confirmed: false,
    errorMessage: '',
    resultMessage: '',
    sessionHint: '',
    pageTitle: '确认后台操作',
    pageDesc: '仅当你正在电脑上主动发起登录或绑定时继续'
  },

  onLoad(options) {
    // 从小程序码参数、普通参数或微信普通链接二维码 q 参数中获取 session_id
    const sessionId = this.getSessionIdFromOptions(options)
    if (!sessionId) {
      this.setData({
        pageTitle: '无效会话',
        pageDesc: '二维码链接缺少登录标识，请返回并重新扫描'
      })
      wx.showModal({
        title: '错误',
        content: '无效的登录会话',
        showCancel: false,
        success() {
          wx.navigateBack()
        }
      })
      return
    }

    if (!/^[a-z0-9]{32}$/.test(sessionId)) {
      this.setData({
        pageTitle: '参数异常',
        pageDesc: '二维码参数异常，请联系管理员重新生成',
        errorMessage: '二维码参数异常，请联系管理员重新生成'
      })
      return
    }

    this.setData({
      sessionId,
      sessionHint: sessionId.slice(-6).toUpperCase()
    })
  },

  getSessionIdFromOptions(options = {}) {
    if (options.session_id) {
      return this.safeDecode(options.session_id)
    }

    if (options.scene) {
      return this.safeDecode(options.scene)
    }

    if (options.q) {
      return this.getSessionIdFromLink(this.safeDecode(options.q))
    }

    return ''
  },

  getSessionIdFromLink(link) {
    const match = `${link}`.match(/[?&]session_id=([^&#]+)/)
    return match ? this.safeDecode(match[1]) : ''
  },

  safeDecode(value) {
    if (typeof value !== 'string' || value.length > 2048) {
      return ''
    }
    try {
      return decodeURIComponent(value)
    } catch {
      return ''
    }
  },

  async onConfirm() {
    if (this.data.loading || this.data.confirmed) {
      return
    }

    if (!this.data.sessionId || this.data.errorMessage) {
      this.setData({ errorMessage: '无效会话，请返回重新扫码' })
      return
    }

    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'confirmLoginSession',
          data: { session_id: this.data.sessionId }
        }
      })

      if (res.result && res.result.code === 0) {
        const message = (res.result.data && res.result.data.message) || '确认成功'
        const sessionType = (res.result.data && res.result.data.type) || ''
        const isBind = sessionType === 'admin_bind' || message.includes('绑定') || message.includes('绑定成功')
        this.setData({
          confirmed: true,
          loading: false,
          errorMessage: '',
          resultMessage: message,
          pageTitle: isBind ? '绑定成功' : '登录成功',
          pageDesc: isBind
            ? '当前微信已成功绑定管理员账号'
            : '管理后台登录已确认，建议返回管理台页面'
        })
        wx.showToast({
          title: isBind ? '绑定成功' : '登录确认成功',
          icon: 'success',
          duration: 1400
        })
        setTimeout(() => {
          this.returnToCallerOrHome()
        }, 2200)
      } else {
        const message = (res.result && res.result.message) || '请重新扫码'
        this.setData({
          loading: false,
          errorMessage: message,
          confirmed: false,
          resultMessage: '',
          pageTitle: '确认失败',
          pageDesc: '请返回管理后台刷新二维码后重试'
        })
        wx.showToast({
          title: message.length > 14 ? '确认失败' : message,
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('确认登录失败:', err)
      this.setData({
        errorMessage: '网络请求失败，请稍后重试',
        confirmed: false,
        resultMessage: '',
        pageTitle: '确认失败',
        pageDesc: '网络请求失败，请稍后重试'
      })
      wx.showToast({ title: '网络请求失败，请稍后重试', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  onCancel() {
    this.returnToCallerOrHome()
  },

  returnToCallerOrHome() {
    wx.navigateBack({
      fail: () => {
        wx.switchTab({ url: '/pages/index/index' })
      }
    })
  }
})
