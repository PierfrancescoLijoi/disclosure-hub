import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the SPA runs on :5173 and proxies the API; in production Fastify serves dist/.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', sourcemap: false },
});
