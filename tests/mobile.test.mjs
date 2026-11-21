import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

test('package.json, capacitor.config.json, and manifest.webmanifest stay aligned for Pocket Lab release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cap = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));

  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(cap.appId, 'io.github.rogentz.pocketlab');
  assert.equal(cap.appName, 'Pocket Lab');
  assert.equal(cap.webDir, 'public');
  assert.equal(manifest.name, 'Pocket Lab');
  assert.equal(manifest.short_name, 'Pocket Lab');
  assert.equal(manifest.theme_color, '#d62828');

  for (const iconPath of [
    'public/assets/icons/icon-192.png',
    'public/assets/icons/icon-512.png',
    'public/assets/icons/icon-512-maskable.png',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, iconPath)), `missing PWA icon: ${iconPath}`);
    const stat = fs.statSync(path.join(ROOT, iconPath));
    assert.ok(stat.size > 500, `PWA icon too small: ${iconPath}`);
  }
});

test('Android launcher/adaptive icons and versionName stay synchronized with package.json & mark.svg', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const resDir = path.join(ROOT, 'android/app/src/main/res');
  const buildGradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert.match(buildGradle, new RegExp(`versionName\\s+"${pkg.version.replace(/\./g, '\\.')}"`));
  assert.match(buildGradle, /applicationId\s+"io\.github\.rogentz\.pocketlab"/);

  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const file of [
      'ic_launcher.png',
      'ic_launcher_round.png',
      'ic_launcher_foreground.png',
      'ic_launcher_background.png',
      'ic_launcher_monochrome.png',
    ]) {
      const p = path.join(resDir, `mipmap-${density}`, file);
      assert.ok(fs.existsSync(p), `missing ${p}`);
      const header = fs.readFileSync(p).subarray(0, 8);
      assert.equal(header.toString('hex'), '89504e470d0a1a0a', `${p} must be a valid PNG`);
    }
  }

  for (const adaptiveFile of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const xml = fs.readFileSync(path.join(resDir, 'mipmap-anydpi-v26', adaptiveFile), 'utf8');
    assert.match(xml, /@mipmap\/ic_launcher_foreground/);
    assert.match(xml, /@mipmap\/ic_launcher_background/);
    assert.match(xml, /@mipmap\/ic_launcher_monochrome/);
  }

  for (const stale of [
    'drawable/ic_launcher_background.xml',
    'drawable-v24/ic_launcher_foreground.xml',
    'values/ic_launcher_background.xml',
  ]) {
    assert.equal(fs.existsSync(path.join(resDir, stale)), false, `stale template icon remains: ${stale}`);
  }
});

test('Public HTML links manifest and keeps relative URLs compatible with Android WebView & GitHub Pages', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /<link\s+rel="manifest"\s+href="manifest\.webmanifest">/);
  assert.match(html, /<link\s+rel="icon"\s+href="assets\/mark\.svg"/);
  assert.match(html, /<link\s+rel="apple-touch-icon"\s+href="assets\/icons\/icon-192\.png">/);
});
