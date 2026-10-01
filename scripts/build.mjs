import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
);
const version = packageJson.version;

// Unique build id per deploy: the browser only treats sw.js as "new" when its
// bytes change, and package.json version rarely bumps. Without this, pushes
// to main ship a byte-identical sw.js so clients never fire `updatefound`
// and stay on stale caches forever. Prefer the git sha (stable per commit,
// changes every deploy); fall back to a timestamp for non-git builds.
function resolveBuildId() {
  for (const cmd of ['git rev-parse --short HEAD', 'git rev-parse HEAD']) {
    try {
      const out = execSync(cmd, {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (out) return out.slice(0, 12);
    } catch {
      // try next
    }
  }
  // GITHUB_SHA is available in Actions even without git CLI edge cases.
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}
const buildId = resolveBuildId();
const cacheName = `jesherhead-v${version}-${buildId}`;

const swPath = path.join(__dirname, '..', 'public', 'sw.js');
const distSwPath = path.join(__dirname, '..', 'dist', 'sw.js');

let swContent = fs.readFileSync(swPath, 'utf-8');

swContent = swContent.replace(/\{\{VERSION\}\}/g, `${version}-${buildId}`);

if (!fs.existsSync(distSwPath)) {
  console.error(
    `✗ dist/sw.js not found. Run 'vite build' first; refusing to overwrite the public/sw.js template (it holds the {{VERSION}} placeholder).`
  );
  process.exit(1);
}
fs.writeFileSync(distSwPath, swContent);
console.log(`✓ Injected version ${version}-${buildId} into dist/sw.js`);

console.log(`✓ Cache name: ${cacheName}`);
