import { defineConfig } from 'vite';

export default defineConfig({
  root: 'www',
  envDir: '..',
  base: '/worker/',
  build: {
    outDir: '../dist-admin/worker',
    emptyOutDir: false,
    target: 'es2020'
  }
});
