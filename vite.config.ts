import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' || mode === 'analyze' ? '/jesherhead/' : '/',
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    minify: 'esbuild',
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
  server: {
    port: 3000,
  },
  plugins: [
    mode === 'analyze' &&
      visualizer({
        open: true,
        filename: 'dist/stats.html',
        gzipSize: true,
        brotliSize: true,
      }),
  ].filter(Boolean),
}));