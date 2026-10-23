import { defineConfig } from 'vite';

export default defineConfig({
  root: 'admin',
  envDir: '..',
  base: './',
  build: {
    outDir: '../dist/admin',
    emptyOutDir: false,
    target: 'es2020'
  }
});
