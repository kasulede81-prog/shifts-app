import { defineConfig } from 'vite';

export default defineConfig({
  root: 'admin',
  envDir: '..',
  base: '/',
  build: {
    outDir: '../dist-admin',
    emptyOutDir: true,
    target: 'es2020'
  }
});
