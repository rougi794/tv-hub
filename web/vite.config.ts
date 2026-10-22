import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import pkg from './package.json';

// index.html picks the interface chosen in the owner section, then opens home.html or kids.html.
// admin.html is the home interface's phone admin, served to the LAN by the TV (AdminServer, port 8080).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // single version source (AUDIT L9): package.json "version", shown on the TV and in the owner section
  define: { __HUB_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        home: path.resolve(__dirname, 'home.html'),
        kids: path.resolve(__dirname, 'kids.html'),
        admin: path.resolve(__dirname, 'admin.html'),
        saver: path.resolve(__dirname, 'saver.html'),   // screensaver (HubDream)
      },
    },
  },
  server: { host: '0.0.0.0', port: 5173 },
});
