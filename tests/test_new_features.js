const http = require('http');
const fs = require('fs');
const path = require('path');
const { server } = require('../src/server');

async function testNewFeatures() {
  const testPort = 3945;
  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`New Features Test running on port ${testPort}`);

  function makeRequest(path, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64');
      const reqHeaders = {
        authorization: authHeader,
        ...headers
      };
      if (body && typeof body === 'object' && !(body instanceof Buffer)) {
        reqHeaders['content-type'] = 'application/json';
        body = JSON.stringify(body);
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: testPort,
          path,
          method,
          headers: reqHeaders
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch(e) {}
            resolve({ statusCode: res.statusCode, headers: res.headers, raw: data, json: parsed });
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  let failures = 0;
  function assert(condition, description) {
    if (condition) {
      console.log(`[PASS] ${description}`);
    } else {
      console.error(`[FAIL] ${description}`);
      failures++;
    }
  }

  try {
    console.log('\n--- 1. Profile Creation & Editing ---');
    // Create Profile
    const createRes = await makeRequest('/api/admin/profiles', 'POST', {
      name: 'Oliver',
      color: '#10b981',
      avatar_type: 'builtin',
      avatar_value: '🚀',
      telegram_id: '998877'
    });
    assert(createRes.statusCode === 200 && createRes.json.ok, 'POST /api/admin/profiles creates profile');
    const profId = createRes.json.profile.id;

    // Edit Profile (PATCH)
    const patchRes = await makeRequest(`/api/admin/profiles/${profId}`, 'PATCH', {
      name: 'Oliver Queen',
      color: '#059669',
      avatar_type: 'builtin',
      avatar_value: '🎯',
      telegram_id: '11223344'
    });
    assert(patchRes.statusCode === 200 && patchRes.json.ok, 'PATCH /api/admin/profiles/:id updates profile');
    assert(patchRes.json.profile.name === 'Oliver Queen', 'Profile name updated');
    assert(patchRes.json.profile.telegram_id === '11223344', 'Profile telegram_id updated');

    // Delete test profile
    await makeRequest(`/api/admin/profiles/${profId}`, 'DELETE');

    console.log('\n--- 2. Separate Day & Night Screensaver Settings ---');
    const settingsRes = await makeRequest('/api/admin/settings', 'POST', {
      sleep_timeout_day: 600,
      screensaver_mode_day: 'pure_photos',
      photo_interval_day: 10,
      night_mode_enabled: 1,
      night_mode_start: '23:00',
      night_mode_end: '06:30',
      sleep_timeout_night: 45,
      screensaver_mode_night: 'clock',
      photo_interval_night: 20
    });
    assert(settingsRes.statusCode === 200 && settingsRes.json.ok, 'POST /api/admin/settings updates settings');
    const s = settingsRes.json.settings;
    assert(s.screensaver_mode_day === 'pure_photos', 'screensaver_mode_day is pure_photos');
    assert(s.sleep_timeout_day === 600, 'sleep_timeout_day numeric conversion preserved');
    assert(s.screensaver_mode_night === 'clock', 'screensaver_mode_night is clock');
    assert(s.sleep_timeout_night === 45, 'sleep_timeout_night numeric conversion preserved');
    assert(s.night_mode_start === '23:00' && s.night_mode_end === '06:30', 'night mode schedule saved');

    console.log('\n--- 3. Multi-Photo Upload ---');
    // Build multipart/form-data with 2 sample PNG images
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    // Minimal 1x1 transparent PNG buffer
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    const postData = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `Vacation Snapshots\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="show_in_screensaver"\r\n\r\n` +
        `1\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photos"; filename="photo1.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`
      ),
      pngBuffer,
      Buffer.from(
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photos"; filename="photo2.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`
      ),
      pngBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const uploadRes = await makeRequest(
      '/api/admin/upload/photos',
      'POST',
      postData,
      { 'content-type': `multipart/form-data; boundary=${boundary}` }
    );
    assert(uploadRes.statusCode === 200 && uploadRes.json.ok, 'POST /api/admin/upload/photos succeeded');
    assert(uploadRes.json.count === 2, 'Batch upload processed 2 files');
    assert(uploadRes.json.photos && uploadRes.json.photos.length === 2, 'Two photo records returned in response');

    // Clean up uploaded test photos
    for (const p of uploadRes.json.photos) {
      await makeRequest(`/api/admin/photos/${p.id}`, 'DELETE');
    }
    console.log('[PASS] Uploaded photos cleaned up');

  } catch (err) {
    console.error('Test error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL NEW FEATURE TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

testNewFeatures();
