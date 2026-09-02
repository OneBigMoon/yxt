const DEFAULT_LOGO = '/images/logo-business.png'
let brandingPromise = null

function normalizeBranding(config = {}) {
  const branding = config.branding && typeof config.branding === 'object'
    ? config.branding
    : {}
  const logoFileId = String(branding.logo_file_id || '').trim()
  return {
    logoFileId,
    logoSrc: logoFileId.startsWith('cloud://') ? logoFileId : DEFAULT_LOGO,
    watermarkEnabled: branding.watermark_enabled !== false
  }
}

function getBranding() {
  if (!brandingPromise) {
    const { getConfig } = require('./api')
    brandingPromise = getConfig()
      .then(normalizeBranding)
      .catch(() => normalizeBranding({}))
      .finally(() => {
        brandingPromise = null
      })
  }
  return brandingPromise
}

module.exports = {
  DEFAULT_LOGO,
  normalizeBranding,
  getBranding
}
