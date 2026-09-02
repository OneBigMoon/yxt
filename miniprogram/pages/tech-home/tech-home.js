const { getTechAppointments, verifyAppointment } = require('../../utils/api')
const { checkAuth } = require('../../utils/auth')

Page({
  data: {
    activeTab: 'home',
    appointments: [],
    stats: {
      pending: 0,
      completed: 0
    },
    todayLabel: '',
    loading: true
  },

  onLoad(options = {}) {
    this.setData({ todayLabel: this.formatMonthDay(new Date()) })
    this._launchVerifyValue = this.getVerificationValueFromScan(options.scene || '')
    this.checkAuth()
  },

  onShow() {
    if (this._authChecked) {
      this.loadAppointments().catch((err) => {
        console.error('工作人员首页刷新失败:', err)
      })
    }
  },

  onPullDownRefresh() {
    this.loadAppointments().then(() => {
      wx.stopPullDownRefresh()
    }).catch((err) => {
      wx.stopPullDownRefresh()
      console.error('工作人员首页下拉刷新失败:', err)
    })
  },

  async checkAuth() {
    const userInfo = await checkAuth({ refresh: true })
    if (!userInfo || userInfo.role !== 'technician') {
      wx.redirectTo({ url: '/pages/login/login' })
      this._authChecked = false
      return null
    }
    this._authChecked = true
    if (this._launchVerifyValue) {
      const verifyValue = this._launchVerifyValue
      this._launchVerifyValue = ''
      this.confirmVerify(verifyValue)
    }
    return userInfo
  },

  async loadAppointments() {
    this.setData({ loading: true })

    try {
      const today = this.formatDate(new Date())
      const appointments = await getTechAppointments({
        date: today
      })

      const pending = appointments.filter(a => a.status === 'pending').length
      const completed = appointments.filter(a => a.status === 'completed').length

      this.setData({
        appointments: appointments || [],
        stats: { pending, completed },
        todayLabel: this.formatMonthDay(new Date()),
        loading: false
      })
    } catch (err) {
      console.error('获取预约列表失败:', err)
      this.setData({ loading: false })
    }
  },

  // 扫码核销
  scanCode() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (res) => {
        const scene = res.result
        if (scene) {
          const loginSessionId = this.getScanLoginSessionId(scene)
          if (loginSessionId) {
            wx.navigateTo({
              url: `/pages/scan-confirm/scan-confirm?session_id=${loginSessionId}`
            })
            return
          }

          const verifyValue = this.getVerificationValueFromScan(scene)
          if (verifyValue) {
            this.confirmVerify(verifyValue)
          } else {
            wx.showToast({ title: '无效的二维码', icon: 'none' })
          }
        } else {
          wx.showToast({ title: '无效的二维码', icon: 'none' })
        }
      },
      fail: (err) => {
        console.error('扫码失败:', err)
        wx.showToast({ title: '扫码取消', icon: 'none' })
      }
    })
  },

  getScanLoginSessionId(value) {
    const match = `${value || ''}`.match(/[?&]session_id=([^&#]+)/)
    return match ? decodeURIComponent(match[1]) : ''
  },

  getVerificationValueFromScan(value) {
    const text = decodeURIComponent(String(value || '').trim())
    if (!text) return ''

    const sceneMatch = text.match(/[?&]scene=([^&#]+)/)
    if (sceneMatch) {
      const scene = decodeURIComponent(sceneMatch[1])
      const code = scene.match(/\b\d{6}\b/)
      return code ? code[0] : scene
    }

    const code = text.match(/^\d{6}$/)
    return code ? code[0] : text
  },

  inputVerifyCode() {
    wx.showModal({
      title: '输入核销码',
      editable: true,
      placeholderText: '请输入 6 位数字',
      confirmText: '核销',
      success: (res) => {
        const code = String(res.content || '').trim()
        if (!res.confirm) return
        if (!/^\d{6}$/.test(code)) {
          wx.showToast({ title: '请输入 6 位数字', icon: 'none' })
          return
        }
        this.confirmVerify(code)
      }
    })
  },

  // 从列表核销
  verifyFromList(e) {
    const id = e.currentTarget.dataset.id
    this.confirmVerify(id)
  },

  confirmVerify(verifyValue) {
    wx.showModal({
      title: '确认核销',
      content: /^\d{6}$/.test(String(verifyValue || '')) ? `核销码：${verifyValue}` : '确定要核销该预约吗？',
      success: (res) => {
        if (res.confirm) {
          void this.verifyAppointment(verifyValue)
        }
      }
    })
  },

  // 核销预约
  async verifyAppointment(appointmentId) {
    try {
      wx.showLoading({ title: '核销中...' })

      const result = await verifyAppointment(appointmentId)

      wx.hideLoading()
      wx.showToast({ title: '核销成功', icon: 'success' })

      // 刷新列表
      setTimeout(() => {
        this.loadAppointments()
      }, 1000)
    } catch (err) {
      wx.hideLoading()
      console.error('核销失败:', err)
      wx.showModal({
        title: '核销失败',
        content: err.message || '请重试',
        showCancel: false
      })
    }
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/tech-records/tech-records' })
  },

  // 格式化日期
  formatDate(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  },

  formatMonthDay(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${month}月${day}日`
  }
})
