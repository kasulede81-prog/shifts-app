import { defineConfig } from 'vite';

export default defineConfig({
  root: 'www',
  envDir: '..',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020'
  }
});
