import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/map_config': 'http://localhost:4000',
      '/map-tiles': 'http://localhost:4000',
      '/bathymetry_config': 'http://localhost:4000',
      '/bathymetry': 'http://localhost:4000',
    },
  },
})
