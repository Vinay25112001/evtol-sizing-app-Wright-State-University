import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/evtol-sizing-app-Wright-State-University/',
  build: {
    minify: false,
    target: 'es2020',
  },
})
