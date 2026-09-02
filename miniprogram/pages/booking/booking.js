const { getServices, getAvailableSlots, checkAvailability, createAppointment, getConfig, getHolidays } = require('../../utils/api')

Page({
  data: {
    currentStep: 1,
    services: [],
    selectedServices: [],
    totalDuration: 0,
    showCalendar: false,
    selectedDate: '',
    minDate: Date.now(),
    maxDate: Date.now() + 14 * 24 * 60 * 60 * 1000,
    timeSlots: [],
    slotsLoading: false,
    selectedSlot: null,
    bookingLoading: false,
    showSuccess: false,
    restDays: [],
    holidays: [],
    bookingSubscribeTemplateIds: [],
    followupSubscribeTemplateIds: [],
    calendarFormatter: null,
    closureNotice: '',
    // 可预约性
    pageLoading: true,
    hasAnyAvailable: false,
    availabilityTitle: '预约已满',
    availabilityMessage: '',
    dateStatus: {},
    activeGuideTab: 'process',
    quickAvailability: [],
    quickAvailabilityLoading: false,
    dateOptions: []
  },

  onLoad() {
    this._authChecked = true
    this.loadConfig()
      .then(() => this.loadServices())
      .then(() => this.scanAvailability())
      .then(() => this.loadQuickAvailability())
      .catch((err) => {
        console.error('[预约页] 初始化失败:', err)
      })

    this.setData({
      calendarFormatter: (day) => {
        const date = new Date(day.date)
        const dateStr = this.formatDate(date)
        const status = this.data.dateStatus[dateStr]

        if (status) {
          if (status.status === 'rest') {
            day.type = 'disabled'
            day.bottomInfo = '休息'
          } else if (status.status === 'closure') {
            day.type = 'disabled'
            day.bottomInfo = '停业'
          } else if (status.status === 'full') {
            day.type = 'disabled'
            day.bottomInfo = '约满'
          }
          // available: 不设置 type，保持可选
        }

        return day
      }
    })
  },

  onShow() {
    // 每次页面显示时刷新配置和可预约状态
    if (this._authChecked) {
      this.loadConfig()
        .then(() => this.scanAvailability())
        .then(() => this.loadQuickAvailability())
        .catch((err) => {
          console.error('[预约页] onShow 刷新失败:', err)
        })
    }
  },

  async scanAvailability() {
    try {
      const serviceIds = this.data.selectedServices.map(service => service._id)
      const params = serviceIds.length
        ? { serviceIds, totalDuration: this.data.totalDuration }
        : {}
      const result = await checkAvailability(params)

      this.setData({
        hasAnyAvailable: result.hasAnyAvailable,
        availabilityTitle: this.getAvailabilityTitle(result.reason_code),
        availabilityMessage: result.message || '',
        dateStatus: result.dateStatus || {},
        dateOptions: this.buildDateOptions(result.dateStatus || {}),
        pageLoading: false
      })
    } catch (err) {
      console.error('扫描可预约日期失败:', err)
      this.setData({
        hasAnyAvailable: false,
        availabilityTitle: '检查失败',
        availabilityMessage: '检查预约状态失败，请重试',
        pageLoading: false
      })
    }
  },

  getAvailabilityTitle(reasonCode) {
    const titleMap = {
      BLACKLISTED: '账号异常',
      NO_ACTIVE_TECHNICIAN: '暂不可预约',
      NO_BUSINESS_HOURS: '暂无营业安排',
      NO_TECHNICIAN_ON_DUTY: '暂不可预约',
      FULLY_BOOKED: '预约已满'
    }
    return titleMap[reasonCode] || '预约已满'
  },

  buildDateOptions(dateStatus = {}) {
    const todayStr = this.formatDate(new Date())
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = this.formatDate(tomorrow)
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const statusText = {
      available: '可预约',
      rest: '休息',
      closure: '停业',
      full: '已约满'
    }

    return Object.keys(dateStatus)
      .sort()
      .map((date) => {
        const itemDate = new Date(date)
        const status = dateStatus[date] && dateStatus[date].status
        return {
          date,
          day: String(itemDate.getDate()).padStart(2, '0'),
          label: date === todayStr ? '今天' : (date === tomorrowStr ? '明天' : weekNames[itemDate.getDay()]),
          status,
          text: statusText[status] || '待确认',
          disabled: status !== 'available'
        }
      })
  },

  async loadQuickAvailability() {
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(today.getDate() + 1)

    const dates = [
      { label: '今日', date: this.formatDate(today) },
      { label: '明日', date: this.formatDate(tomorrow) }
    ]

    this.setData({ quickAvailabilityLoading: true })

    try {
      const cards = await Promise.all(dates.map(async item => {
        const status = this.data.dateStatus[item.date]
        if (status && status.status !== 'available') {
          return {
            ...item,
            count: 0,
            status: status.status,
            text: this.getQuickStatusText(status)
          }
        }

        const slots = await getAvailableSlots({
          date: item.date,
          serviceIds: [],
          totalDuration: 30
        })
        const count = (slots || []).filter(slot => slot.available).length
        return {
          ...item,
          count,
          status: count > 0 ? 'available' : 'full',
          text: count > 0 ? `剩余 ${count} 个时段` : '暂无可约时段'
        }
      }))

      this.setData({
        quickAvailability: cards,
        quickAvailabilityLoading: false
      })
    } catch (err) {
      console.error('获取快捷可约时段失败:', err)
      this.setData({
        quickAvailability: dates.map(item => ({
          ...item,
          count: 0,
          status: 'pending',
          text: '待刷新'
        })),
        quickAvailabilityLoading: false
      })
    }
  },

  getQuickStatusText(statusInfo) {
    const status = statusInfo && statusInfo.status
    const map = {
      rest: '休息',
      closure: statusInfo && statusInfo.reason ? `停业：${statusInfo.reason}` : '停业',
      full: '暂无可约时段'
    }
    return map[status] || '待确认'
  },

  async loadServices() {
    try {
      const services = await getServices()
      this.setData({
        services: (services || []).map(s => ({
          ...s,
          selected: false
        }))
      })
    } catch (err) {
      console.error('获取服务列表失败:', err)
    }
  },

  async loadConfig() {
    try {
      const config = await getConfig()
      const holidaysData = await getHolidays({ type: 'closure' })
      const subscribeTemplates = config.subscribe_templates || {}
      const normalizeTemplateIds = values => [...new Set((Array.isArray(values) ? values : [])
        .map(value => String(value || '').trim())
        .filter(Boolean))].slice(0, 3)

      const maxAdvanceDays = config.max_advance_days || 14
      const maxDate = Date.now() + maxAdvanceDays * 24 * 60 * 60 * 1000

      const restDays = []
      if (config.schedule) {
        for (let i = 1; i <= 7; i++) {
          if (!config.schedule[i] || config.schedule[i].length === 0) {
            restDays.push(i)
          }
        }
      }

      this.setData({
        maxDate,
        restDays,
        holidays: holidaysData || [],
        bookingSubscribeTemplateIds: normalizeTemplateIds(subscribeTemplates.booking),
        followupSubscribeTemplateIds: normalizeTemplateIds(subscribeTemplates.follow_up)
      })
    } catch (err) {
      console.error('获取配置失败:', err)
    }
  },

  onCalendarDayClick(e) {
    const date = new Date(e.detail)
    const dateStr = this.formatDate(date)
    const status = this.data.dateStatus[dateStr]

    if (status && status.status === 'rest') {
      wx.showToast({ title: '该日为休息日', icon: 'none' })
      return
    }
    if (status && status.status === 'closure') {
      wx.showToast({ title: status.reason || '当日停业', icon: 'none' })
      return
    }
    if (status && status.status === 'full') {
      wx.showToast({ title: '该日预约已满', icon: 'none' })
      return
    }

    this.setData({
      selectedDate: dateStr,
      showCalendar: false
    }, () => {
      this.nextStep()
    })
  },

  selectDateOption(e) {
    const date = e.currentTarget.dataset.date
    if (date) {
      this.onCalendarDayClick({ detail: date })
    }
  },

  formatDate(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  },

  toggleService(e) {
    const index = e.currentTarget.dataset.index
    const services = this.data.services.map((s, i) => ({
      ...s,
      selected: i === index
    }))

    const selectedServices = services.filter(s => s.selected)
    const totalDuration = selectedServices.reduce((sum, s) => sum + s.duration, 0)

    this.setData({ services, selectedServices, totalDuration }, () => {
      if (selectedServices.length > 0) {
        this.nextStep()
      }
    })
  },

  nextStep() {
    // 步骤1：必须选日期
    if (this.data.currentStep === 1) {
      if (!this.data.selectedDate) {
        wx.showToast({ title: '请选择预约日期', icon: 'none' })
        return
      }
      this.setData({ currentStep: 2 })
      return
    }

    // 步骤2：必须选服务
    if (this.data.currentStep === 2) {
      if (this.data.selectedServices.length === 0) {
        wx.showToast({ title: '请至少选择一个服务项目', icon: 'none' })
        return
      }
      // 用实际时长验证所选日期是否还有空位
      this.verifyDateAvailability()
      return
    }
  },

  prevStep() {
    if (this.data.currentStep === 2) {
      // 返回日期选择时，用已选服务时长重新扫描可用日期
      this.setData({ currentStep: 1, selectedDate: '', selectedSlot: null })
      if (this.data.totalDuration > 0) {
        this.scanAvailability()
      }
    } else if (this.data.currentStep === 3) {
      this.setData({ currentStep: 2, selectedSlot: null, timeSlots: [] })
    }
  },

  async verifyDateAvailability() {
    wx.showLoading({ title: '验证时段...' })
    try {
      const result = await checkAvailability({
        serviceIds: this.data.selectedServices.map(service => service._id),
        totalDuration: this.data.totalDuration
      })
      const dateStatus = result.dateStatus || {}
      const todayStatus = dateStatus[this.data.selectedDate]

      wx.hideLoading()

      if (todayStatus && todayStatus.status === 'full') {
        // 所选日期已满，更新日历状态，回到日期选择
        this.setData({
          dateStatus,
          selectedDate: '',
          currentStep: 1
        })
        wx.showToast({ title: '该日期已约满，请重新选择', icon: 'none' })
        return
      }

      // 日期可用，进入时段选择
      this.setData({ currentStep: 3 })
      this.loadTimeSlots()
    } catch (err) {
      wx.hideLoading()
      console.error('验证日期可用性失败:', err)
      // 验证失败也允许继续
      this.setData({ currentStep: 3 })
      this.loadTimeSlots()
    }
  },

  openCalendar() {
    this.setData({ showCalendar: true })
  },

  onCalendarClose() {
    this.setData({ showCalendar: false })
  },

  switchGuideTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab) {
      this.setData({ activeGuideTab: tab })
    }
  },

  jumpToBooking() {
    if (this.data.currentStep === 1) {
      this.openCalendar()
      return
    }

    wx.showToast({ title: '请继续完成当前步骤', icon: 'none' })
  },

  async loadTimeSlots() {
    this.setData({ slotsLoading: true, timeSlots: [] })

    try {
      const serviceIds = this.data.selectedServices.map(s => s._id)
      const slots = await getAvailableSlots({
        date: this.data.selectedDate,
        serviceIds: serviceIds,
        totalDuration: this.data.totalDuration
      })

      this.setData({
        timeSlots: (slots || []).filter(s => s.available).map(s => ({
          ...s,
          selected: false
        })),
        slotsLoading: false
      })
    } catch (err) {
      console.error('获取时段失败:', err)
      this.setData({ slotsLoading: false })
      wx.showToast({ title: '获取时段失败', icon: 'none' })
    }
  },

  selectSlot(e) {
    const index = e.currentTarget.dataset.index
    const slot = this.data.timeSlots[index]

    const timeSlots = this.data.timeSlots.map((s, i) => ({
      ...s,
      selected: i === index
    }))

    this.setData({ timeSlots, selectedSlot: slot })
  },

  requestSubscribeMessages(templateIds = []) {
    const tmplIds = [...new Set((Array.isArray(templateIds) ? templateIds : [])
      .map(value => String(value || '').trim())
      .filter(Boolean))].slice(0, 3)

    if (tmplIds.length === 0 || typeof wx.requestSubscribeMessage !== 'function') {
      return Promise.resolve()
    }

    return new Promise(resolve => {
      try {
        wx.requestSubscribeMessage({
          tmplIds,
          complete: () => resolve()
        })
      } catch (err) {
        console.warn('订阅消息授权失败:', err)
        resolve()
      }
    })
  },

  async confirmBooking() {
    if (!this.data.selectedSlot) {
      wx.showToast({ title: '请选择时段', icon: 'none' })
      return
    }

    const { checkAuth } = require('../../utils/auth')
    const userInfo = await checkAuth()
    if (!userInfo) {
      wx.showToast({ title: '请先登录后确认预约', icon: 'none' })
      wx.navigateTo({ url: '/pages/login/login' })
      return
    }

    await this.requestSubscribeMessages(this.data.bookingSubscribeTemplateIds)
    this.setData({ bookingLoading: true })

    try {
      const serviceIds = this.data.selectedServices.map(s => s._id)
      this._bookingRequestId = this._bookingRequestId || this.createBookingRequestId()
      await createAppointment({
        services: serviceIds,
        date: this.data.selectedDate,
        start_time: this.data.selectedSlot.time.split('-')[0],
        end_time: this.data.selectedSlot.time.split('-')[1],
        total_duration: this.data.totalDuration,
        request_id: this._bookingRequestId
      })

      this._bookingRequestId = ''
      this.setData({ showSuccess: true, bookingLoading: false })
    } catch (err) {
      console.error('预约失败:', err)
      this.setData({ bookingLoading: false, selectedSlot: null })

      if (err.message && err.message.includes('约满')) {
        wx.showToast({ title: '该时段已约满，正在刷新', icon: 'none' })
        this.loadTimeSlots()
      } else {
        wx.showToast({ title: err.message || '预约失败', icon: 'none' })
      }
    }
  },

  createBookingRequestId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`
  },

  async goToAppointments() {
    await this.requestSubscribeMessages(this.data.followupSubscribeTemplateIds)
    this.setData({ showSuccess: false })
    wx.navigateTo({ url: '/pages/my-appointments/my-appointments' })
  },

  onSuccessClose() {
    this.setData({ showSuccess: false })
  }
})
