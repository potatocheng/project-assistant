import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@mariozechner\/pi-ai$/,
        replacement: fileURLToPath(new URL('./src/components/shell/pi-ai-browser-shim.mjs', import.meta.url)),
      },
    ],
  },
  optimizeDeps: {
    // The pi-ai browser shim reaches this CommonJS dependency through a deep import.
    include: ['partial-json'],
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/target/**', '**/src-tauri/**', '**/.local-data/**', '**/.playwright-cli/**', '**/output/**'] },
  },
  envPrefix: ['VITE_'],
  build: { target: 'es2022' },
});
