import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function viteBase(command: 'build' | 'serve') {
  const fromEnv = process.env.VITE_BASE
  if (fromEnv) return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`
  // 开发仍走根路径；生产默认对应 https://sora233.github.io/xiaohuajia/
  if (command === 'serve') return './'
  return '/xiaohuajia/'
}

export default defineConfig(({ command }) => ({
  base: viteBase(command),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 45217,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 45217,
    strictPort: true,
  },
}))
