const { buildCloudFunctionError } = require('./error')

// 云函数调用封装
const callFunction = (name, data = {}) => {
  const start = Date.now()
  const requestTag = `${name}_${start}_${Math.floor(Math.random() * 10000)}`
  return new Promise((resolve, reject) => {
    const callOptions = {
      name,
      data,
      success: (res) => {
        if (res && res.result && res.result.code === 0) {
          resolve(res.result.data)
          return
        }

        console.error(`wx.cloud.callFunction [${requestTag}] business failed`, {
          name,
          code: res && res.result && res.result.code
        })
        const businessMessage = res && res.result && (res.result.message || '请求失败')
        const businessCode = res && res.result && res.result.code
        const businessError = buildCloudFunctionError(name, requestTag, {
          message: businessMessage,
          errCode: businessCode
        })
        reject(businessError)
      },
      fail: (err) => {
        const normalizedError = buildCloudFunctionError(name, requestTag, err)
        console.error(`wx.cloud.callFunction [${requestTag}] failed`, {
          name,
          error: normalizedError
        })
        reject(normalizedError)
      }
    }

    wx.cloud.callFunction(callOptions)
  })
}

const login = (userInfo) => callFunction('login', userInfo)
const getServices = () => callFunction('getServices')
const getAvailableSlots = (data) => callFunction('getAvailableSlots', data)
const checkAvailability = (data) => callFunction('checkAvailability', data)
const createAppointment = (data) => callFunction('createAppointment', data)
const cancelAppointment = (id) => callFunction('cancelAppointment', { id })
const verifyAppointment = (id) => callFunction('verifyAppointment', { id })
const getMyAppointments = (data) => callFunction('getMyAppointments', data)
const getTechAppointments = (data) => callFunction('getAppointments', data)
const getArticles = (data = {}) => callFunction('getArticles', data)
const getArticleDetail = (id) => callFunction('getArticleDetail', { id })
const getConfig = () => callFunction('admin', { action: 'getConfig' })
const getHolidays = (data) => callFunction('admin', { action: 'getHolidays', data })

module.exports = {
  callFunction,
  login,
  getServices,
  getAvailableSlots,
  checkAvailability,
  createAppointment,
  cancelAppointment,
  verifyAppointment,
  getMyAppointments,
  getTechAppointments,
  getArticles,
  getArticleDetail,
  getConfig,
  getHolidays
}
