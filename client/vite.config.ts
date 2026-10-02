import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER = process.env.PAIRPAD_SERVER ?? 'http://localhost:3001'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Two copies of Yjs in one bundle break instanceof checks between packages.
    dedupe: ['yjs'],
  },
  build: {
    // The editor chunk (CodeMirror + Yjs) is ~590 kB and already lazy-loaded.
    chunkSizeWarningLimit: 650,
  },
  server: {
    port: 5173,
    // In dev the page comes from Vite; API and WebSocket go to the Node server.
    proxy: {
      '/api': SERVER,
      '/health': SERVER,
      '/ws': { target: SERVER, ws: true },
    },
  },
})
