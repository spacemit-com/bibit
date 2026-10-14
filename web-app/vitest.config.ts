import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'node_modules/',
        'dist/',
        'coverage/',
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/test/**/*',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@bibit/feature-contracts': path.resolve(__dirname, '../packages/feature-contracts/src/index.ts'),
      '@bibit/feature-sdk': path.resolve(__dirname, '../packages/feature-sdk/src/index.ts'),
      '@bibit/feature-ui': path.resolve(__dirname, '../packages/feature-ui/src/index.ts'),
      '@janhq/assistant-extension': path.resolve(__dirname, '../extensions/assistant-extension/dist/index.js'),
      '@janhq/conversational-extension': path.resolve(__dirname, '../extensions/conversational-extension/dist/index.js'),
      '@janhq/download-extension': path.resolve(__dirname, '../extensions/download-extension/dist/index.js'),
      '@janhq/llamacpp-extension': path.resolve(__dirname, '../extensions/llamacpp-extension/dist/index.js'),
      '@janhq/rag-extension': path.resolve(__dirname, '../extensions/rag-extension/dist/index.js'),
      '@janhq/vector-db-extension': path.resolve(__dirname, '../extensions/vector-db-extension/dist/index.js'),
    },
  },
  define: {
    IS_TAURI: JSON.stringify(false),
    IS_WEB_APP: JSON.stringify(false),
    IS_LINUX: JSON.stringify(true),
    BIBIT_SECURITY_DEMO: JSON.stringify(false),
    PLATFORM: JSON.stringify('web'),
    VERSION: JSON.stringify('test'),
  },
})
