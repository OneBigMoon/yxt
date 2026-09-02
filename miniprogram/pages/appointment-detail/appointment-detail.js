const { getMyAppointments, cancelAppointment } = require('../../utils/api')

Page({
  data: {
    appointment: {},
    loading: true,
    cancelling: false
  },

  onLoad(options) {
    if (!options.id) {
      this.setData({ loading: false })
      wx.showToast({ title: '预约不存在', icon: 'none' })
      setTimeout(() => {
        wx.navigateBack()
      }, 1500)
      return
    }
    this.loadAppointment(options.id)
  },

  async loadAppointment(id) {
    this.setData({ loading: true })

    try {
      const appointments = await getMyAppointments({ id: id })
      if (appointments && appointments.length > 0) {
        const appointment = appointments[0]
        this.setData({
          appointment: {
            ...appointment,
            display_verify_code: this.getDisplayVerifyCode(appointment)
          },
          loading: false
        })
      } else {
        this.setData({ loading: false })
        wx.showToast({ title: '预约不存在', icon: 'none' })
        setTimeout(() => {
          wx.navigateBack()
        }, 1500)
      }
    } catch (err) {
      console.error('获取预约详情失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  cancelAppointment() {
    wx.showModal({
      title: '确认取消',
      content: '确定要取消这个预约吗？取消后名额将立即释放。',
      confirmText: '确定取消',
      confirmColor: '#ee0a24',
      success: async (res) => {
        if (res.confirm) {
          this.setData({ cancelling: true })

          try {
            await cancelAppointment(this.data.appointment._id)
            wx.showToast({ title: '取消成功', icon: 'success' })

            // 刷新预约详情
            setTimeout(() => {
              this.loadAppointment(this.data.appointment._id)
            }, 1000)
          } catch (err) {
            console.error('取消预约失败:', err)
            wx.showToast({ title: err.message || '取消失败', icon: 'none' })
          } finally {
            this.setData({ cancelling: false })
          }
        }
      }
    })
  },

  getDisplayVerifyCode(appointment) {
    const code = appointment && (appointment.verify_code || appointment.qr_scene)
    return /^\d{6}$/.test(String(code || '')) ? code : ''
  }
})
