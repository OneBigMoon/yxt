App({
  globalData: {
    userInfo: null,
    role: null,
    openid: null
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }
    wx.cloud.init({
      env: 'yuyue-d0gdy87711d685d64',
      traceUser: true
    })
  },

  onShow(options) {
    const sessionId = this._getScanLoginSessionId(options)
    if (sessionId) {
      const currentPages = getCurrentPages()
      const currentRoute = currentPages.length ? currentPages[currentPages.length - 1].route : ''
      if (currentRoute === 'pages/scan-confirm/scan-confirm') {
        return
      }

      wx.navigateTo({
        url: `/pages/scan-confirm/scan-confirm?session_id=${sessionId}`
      })
    }
  },

  _getScanLoginSessionId(options = {}) {
    if (options.scene) {
      return this._extractSessionId(this._safeDecode(options.scene))
    }

    if (options.query && options.query.session_id) {
      return this._extractSessionId(this._safeDecode(options.query.session_id))
    }

    if (options.path) {
      return this._extractSessionId(this._safeDecode(options.path))
    }

    if (options.query && options.query.q) {
      return this._extractSessionIdFromLink(this._safeDecode(options.query.q))
    }

    return ''
  },

  _extractSessionId(value = '') {
    const text = String(value || '').trim()
    if (!text) {
      return ''
    }

    const plainMatch = text.match(/^[a-z0-9]{32}$/i)?.[0]
    if (plainMatch) {
      return plainMatch
    }

    return this._extractSessionIdFromLink(text)
  },

  _extractSessionIdFromLink(link = '') {
    const match = String(link || '').match(/[?&]session_id=([^&#]+)/)
    return match ? this._safeDecode(match[1]) : ''
  },

  _safeDecode(value) {
    if (typeof value !== 'string' || value.length > 2048) {
      return ''
    }
    try {
      return decodeURIComponent(value)
    } catch {
      return ''
    }
  },

  onError(error) {
    const isKnownDevtoolsTimeout = this._isKnownDevtoolsTimeoutError(error)
    if (isKnownDevtoolsTimeout) {
      console.warn('[global onError] 已识别开发者工具启动超时噪音')
      return
    }

    if (error && error.message) {
      console.error('[global onError]', error.message, {
        stack: error.stack,
        isKnownDevtoolsTimeout
      })
      return
    }

    console.error('[global onError]', error, { isKnownDevtoolsTimeout })
  },

  onUnhandledRejection(reason) {
    const normalizedReason = reason && reason.reason ? reason.reason : reason
    const isKnownDevtoolsTimeout = this._isKnownDevtoolsTimeoutError(normalizedReason)

    if (isKnownDevtoolsTimeout) {
      console.warn('[global onUnhandledRejection] 已识别开发者工具启动超时噪音')
      return
    }

    if (normalizedReason && normalizedReason.message) {
      console.error('[global onUnhandledRejection]', normalizedReason.message, {
        stack: normalizedReason.stack,
        isKnownDevtoolsTimeout,
        reason: normalizedReason
      })
    } else {
      console.error('[global onUnhandledRejection]', normalizedReason, { isKnownDevtoolsTimeout })
    }
  },

  _isKnownDevtoolsTimeoutError(error) {
    if (!error) {
      return false
    }

    const message = this._getErrorMessage(error)
    if (!message.includes('timeout')) {
      return false
    }

    const stack = `${error.stack || ''}`
    return stack.includes('WAServiceMainContext')
  },

  _getErrorMessage(error) {
    if (!error) {
      return ''
    }
    if (error.message) {
      return error.message
    }
    if (error.errMsg) {
      return error.errMsg
    }
    return `${error}`
  }
})
