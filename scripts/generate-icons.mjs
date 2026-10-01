import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const inputIcon = path.join(root, 'public', 'icon.png');
const outputDir = path.join(root, 'public', 'icons');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

async function generateIcons() {
  if (!fs.existsSync(inputIcon)) {
    console.error(`Input icon not found: ${inputIcon}`);
    process.exit(1);
  }
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`Generating icons from ${inputIcon}...`);

  for (const size of sizes) {
    const outputPath = path.join(outputDir, `icon-${size}x${size}.png`);
    await sharp(inputIcon)
      .resize(size, size, { fit: 'cover', position: 'center' })
      .png()
      .toFile(outputPath);
    console.log(`  ✓ ${size}x${size}`);
  }

  console.log('\nGenerating maskable icons (opaque background required)...');
  for (const size of sizes) {
    const outputPath = path.join(outputDir, `icon-${size}x${size}-maskable.png`);
    const padding = Math.round(size * 0.1);
    await sharp(inputIcon)
      .resize(size - padding * 2, size - padding * 2, { fit: 'contain' })
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: { r: 17, g: 17, b: 17, alpha: 1 },
      })
      .png()
      .toFile(outputPath);
    console.log(`  ✓ ${size}x${size} (maskable)`);
  }

  console.log('\nDone! Icons saved to:', outputDir);
}

generateIcons().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
