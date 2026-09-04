import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies the API so the browser sees one origin. That keeps
// cookies and WebSocket upgrades working without loosening CORS in development.
const GATEWAY = process.env.CODECRAFT_GATEWAY ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: GATEWAY,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Monaco is a few megabytes however it is split; it loads as its own chunk
    // in parallel with the app. The default 500 kB warning only adds noise.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Monaco is far larger than everything else; splitting it keeps the
        // initial bundle small and lets the editor load in parallel.
        manualChunks: {
          monaco: ['monaco-editor', '@monaco-editor/react'],
          terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
