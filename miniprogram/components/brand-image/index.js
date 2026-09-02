const { DEFAULT_LOGO, getBranding } = require('../../utils/branding')

Component({
  options: {
    virtualHost: true
  },
  externalClasses: ['custom-class'],
  properties: {
    mode: {
      type: String,
      value: 'aspectFit'
    },
    watermark: {
      type: Boolean,
      value: false
    }
  },
  data: {
    src: DEFAULT_LOGO,
    visible: true
  },
  lifetimes: {
    attached() {
      getBranding().then(branding => {
        this.setData({
          src: branding.logoSrc,
          visible: !this.properties.watermark || branding.watermarkEnabled
        })
      })
    }
  },
  methods: {
    handleError() {
      if (this.data.src !== DEFAULT_LOGO) {
        this.setData({ src: DEFAULT_LOGO })
      }
    }
  }
})
