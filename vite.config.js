import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/eVTOL_Website_Trail_1/',
  build: {
    // Disable identifier minification to prevent esbuild TDZ collision
    // where minified single-letter names (like 'h') conflict across scopes.
    // minifyWhitespace + minifySyntax still run so bundle stays small.
    minify: 'esbuild',
    target: 'es2020',
  },
  esbuild: {
    minifyIdentifiers: false,
    minifySyntax: true,
    minifyWhitespace: true,
  },
})
