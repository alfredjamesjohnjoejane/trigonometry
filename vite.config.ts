import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(({ mode }) => ({
  // Relative base so the build works from any mount point: GitHub Pages
  // project sites (/<repo>/), a custom domain at the root, or a local
  // preview. A hardcoded '/jesherhead/' 404s as soon as the repo is renamed
  // or forked — the bundle then never loads and the PWA install gate can
  // never be dismissed.
  base: mode === 'production' || mode === 'analyze' ? './' : '/',
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