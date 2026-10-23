import { defineConfig } from 'vite';

export default defineConfig({
  root: 'admin',
  envDir: '..',
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/worker': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worker/, '') || '/'
      }
    }
  },
  build: {
    outDir: '../dist-admin',
    emptyOutDir: true,
    target: 'es2020'
  }
});
