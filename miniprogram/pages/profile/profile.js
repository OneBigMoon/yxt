const { checkAuth, updateProfile } = require('../../utils/auth')

Page({
  data: {
    avatarUrl: '',
    nickName: '',
    loading: false
  },

  async onLoad() {
    const userInfo = await checkAuth()
    if (!userInfo) {
      wx.redirectTo({ url: '/pages/login/login' })
      return
    }

    this.setData({
      avatarUrl: userInfo.avatar_url || '',
      nickName: userInfo.nick_name === '微信用户' ? '' : (userInfo.nick_name || '')
    })
  },

  onNicknameChange(e) {
    this.setData({ nickName: e.detail.value })
  },

  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    if (!avatarUrl) return

    // 上传头像到云存储
    wx.showLoading({ title: '上传头像中...' })
    try {
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`,
        filePath: avatarUrl
      })
      this.setData({ avatarUrl: uploadRes.fileID })
      wx.hideLoading()
    } catch (err) {
      wx.hideLoading()
      console.error('头像上传失败:', err)
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
    }
  },

  async onSubmit() {
    this.setData({ loading: true })

    try {
      await updateProfile((this.data.nickName || '').trim(), this.data.avatarUrl)

      wx.showToast({ title: '保存成功', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/mine/mine' })
      }, 1000)
    } catch (err) {
      console.error('保存资料失败:', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
