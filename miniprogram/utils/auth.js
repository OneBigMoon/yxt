const app = getApp()
const { callFunction } = require('./api')

const syncUserToGlobal = (data) => {
  if (!data) {
    return null
  }

  app.globalData.userInfo = data
  app.globalData.role = data.role
  wx.setStorageSync('userInfo', data)

  return data
}

const fullLogin = async (userInfo, phoneCode) => {
  const user = await callFunction('login', {
    type: 'login',
    userInfo,
    phoneCode
  })

  if (!user) {
    throw new Error('登录失败')
  }
  return syncUserToGlobal(user)
}

const refreshSession = async () => {
  const localUser = wx.getStorageSync('userInfo')
  if (!localUser) {
    return null
  }

  const user = await callFunction('login', { type: 'refresh' })
  if (!user) {
    logout()
    return null
  }

  return syncUserToGlobal(user)
}

const updateProfile = async (nickName, avatarUrl) => {
  const user = await callFunction('login', {
    type: 'updateProfile',
    nickName,
    avatarUrl
  })

  if (!user) {
    throw new Error('更新失败')
  }
  return syncUserToGlobal(user)
}

const deleteAccount = async () => {
  const result = await callFunction('login', { type: 'deleteAccount' })
  logout()
  return result
}

const checkBlacklist = async () => {
  const localUser = wx.getStorageSync('userInfo')
  if (!localUser) {
    return false
  }

  const latest = await refreshSession()
  return Boolean(latest && latest.is_blacklisted)
}

const checkAuth = async (options = {}) => {
  const userInfo = wx.getStorageSync('userInfo')
  if (!userInfo) {
    return null
  }

  syncUserToGlobal(userInfo)

  if (!options.refresh) {
    return userInfo
  }

  try {
    return await refreshSession()
  } catch (err) {
    console.warn('刷新登录态失败:', err)
    return userInfo
  }
}

const logout = () => {
  app.globalData.userInfo = null
  app.globalData.role = null
  app.globalData.openid = null
  wx.removeStorageSync('userInfo')
}

module.exports = {
  fullLogin,
  refreshSession,
  updateProfile,
  deleteAccount,
  checkBlacklist,
  checkAuth,
  logout
}
