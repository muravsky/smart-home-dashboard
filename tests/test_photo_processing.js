const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { photosDir, createScreensaverDerivative } = require('../src/middleware/upload');

async function run() {
  const sourcePath = path.join(os.tmpdir(), `dashboard-photo-${Date.now()}.png`);
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#4682b4' } }).png().toFile(sourcePath);
  let derivative;
  try {
    derivative = await createScreensaverDerivative(sourcePath, path.basename(sourcePath));
    const metadata = await sharp(derivative.path).metadata();
    assert.strictEqual(metadata.format, 'jpeg', 'screensaver output should use optimized JPEG');
    assert(metadata.width <= 1920 && metadata.height <= 1080, 'screensaver derivative should fit within 1080p');
    console.log('Screensaver photo resize and format checks passed');
  } finally {
    await fs.promises.unlink(sourcePath).catch(() => {});
    if (derivative) await fs.promises.unlink(path.join(photosDir, derivative.filename)).catch(() => {});
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
