import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  server: {
    port: 3000
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }

          if (id.includes('@wangeditor')) {
            return 'vendor-editor'
          }
          if (id.includes('element-plus') || id.includes('@element-plus')) {
            return 'vendor-element'
          }
          if (id.includes('@cloudbase')) {
            return 'vendor-cloudbase'
          }
          if (id.includes('qrcode')) {
            return 'vendor-qrcode'
          }
          if (id.includes('dayjs')) {
            return 'vendor-dayjs'
          }
          if (id.includes('vue')) {
            return 'vendor-vue'
          }

          return 'vendor'
        }
      }
    }
  }
})
