import { defineConfig } from 'vite';

// Local dev: the app on 1186, the backend on 1184. /api and /ws are proxied
// so the browser talks to one origin and VITE_API_BASE_URL can stay unset.
const backend = process.env.VITE_DEV_API || 'http://localhost:1184';

export default defineConfig({
  server: {
    host: true,
    port: 1186,
    strictPort: true,
    // Allow any Host header, so the dev server also works through port
    // forwarding or a LAN hostname, not only localhost.
    allowedHosts: true,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  preview: { host: true, port: 1186, strictPort: true },
  build: { target: 'es2022' },
});
