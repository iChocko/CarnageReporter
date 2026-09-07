import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Config de tests (Fase C3): reusa el plugin de React del propio vite.config
// para que JSX se transforme igual en tests que en build/dev.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
})
