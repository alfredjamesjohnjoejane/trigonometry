import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { execSync } from 'child_process';
import { createHash } from 'crypto';

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

// Lumin vendor self-check: public/vendor/lumin.min.js must match the bytes +
// sha256 recorded in lumin.version.json, or school-filter fallback silently
// serves a stale/mismatched SDK. Fails the build so drift is caught in CI.
try {
  const vendorPath = path.join(__dirname, '..', 'public', 'vendor', 'lumin.min.js');
  const metaPath = path.join(__dirname, '..', 'public', 'vendor', 'lumin.version.json');
  if (fs.existsSync(vendorPath) && fs.existsSync(metaPath)) {
    const bytes = fs.readFileSync(vendorPath);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (typeof meta.bytes === 'number' && meta.bytes !== bytes.length) {
      console.error(`✗ lumin vendor size drift: file=${bytes.length} meta=${meta.bytes}`);
      process.exit(1);
    }
    if (typeof meta.sha256 === 'string' && meta.sha256 !== sha) {
      console.error('✗ lumin vendor sha256 drift: update public/vendor/lumin.version.json');
      process.exit(1);
    }
    if (!bytes.includes('Lumin')) {
      console.error('✗ lumin vendor sanity check failed: no Lumin marker in bytes');
      process.exit(1);
    }
    console.log(`✓ Lumin vendor OK (${bytes.length}B, sha256 ${sha.slice(0, 12)}…)`);
  }
} catch (err) {
  if (err && err.code === 'ERR_EXEC_ABORT') throw err;
  console.error('✗ lumin vendor check crashed:', err);
  process.exit(1);
}

console.log(`✓ Cache name: ${cacheName}`);
