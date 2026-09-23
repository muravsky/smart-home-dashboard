const http = require('http');
const fs = require('fs');
const path = require('path');
const { io: ioClient } = require('socket.io-client');
const { server } = require('../src/server');

async function runPhase5Tests() {
  const testPort = 3977;

  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Phase 5 Test Server running on port ${testPort}`);

  function makeRequest(path, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64');
      const reqHeaders = {
        authorization: authHeader,
        ...headers
      };
      if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !headers['content-type']) {
        reqHeaders['content-type'] = 'application/json';
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
            try { parsed = JSON.parse(data); } catch (e) {}
            resolve({ statusCode: res.statusCode, headers: res.headers, raw: data, json: parsed });
          });
        }
      );
      req.on('error', reject);
      if (body) {
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
          req.write(body);
        } else {
          req.write(JSON.stringify(body));
        }
      }
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
    console.log('\n--- 1. Photo Query & Security API ---');
    // Public endpoint without token -> 403
    const unauthPhotosRes = await makeRequest('/api/photos', 'GET', null, { authorization: '' });
    assert(unauthPhotosRes.statusCode === 403, 'GET /api/photos without token returns 403 Forbidden');

    // Public endpoint with valid token -> 200
    const tokenPhotosRes = await makeRequest('/api/photos?token=your_secret_token', 'GET', null, { authorization: '' });
    assert(tokenPhotosRes.statusCode === 200, 'GET /api/photos?token=your_secret_token returns 200');
    assert(Array.isArray(tokenPhotosRes.json), 'GET /api/photos returns array of screensaver photos');

    // Admin endpoint
    const adminPhotosRes = await makeRequest('/api/admin/photos');
    assert(adminPhotosRes.statusCode === 200, 'GET /api/admin/photos returns 200');
    assert(Array.isArray(adminPhotosRes.json), 'GET /api/admin/photos returns array of all photos');

    console.log('\n--- 2. Photo Upload & Management API ---');
    // Prepare a small 1x1 test PNG buffer
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82
    ]);

    const boundary = '----WebKitFormBoundaryTest12345';
    let bodyBuffer = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nSunset at Lake\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="show_in_screensaver"\r\n\r\n1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="sunset.png"\r\nContent-Type: image/png\r\n\r\n`),
      pngHeader,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const uploadRes = await makeRequest('/api/admin/upload/photo', 'POST', bodyBuffer, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': bodyBuffer.length
    });

    assert(uploadRes.statusCode === 200 && uploadRes.json.ok, 'POST /api/admin/upload/photo uploaded photo');
    const photoId = uploadRes.json.photo.id;
    assert(uploadRes.json.photo.caption === 'Sunset at Lake', 'Photo caption saved correctly');
    assert(uploadRes.json.photo.show_in_screensaver === 1, 'Photo show_in_screensaver set to 1');

    // Update photo (toggle off screensaver)
    const updateRes = await makeRequest(`/api/admin/photos/${photoId}`, 'PATCH', {
      caption: 'Sunset at Lake Updated',
      show_in_screensaver: 0
    });
    assert(updateRes.statusCode === 200 && updateRes.json.ok, 'PATCH /api/admin/photos/:id updated photo');
    assert(updateRes.json.photo.show_in_screensaver === 0, 'Photo show_in_screensaver toggled to 0');

    console.log('\n--- 3. Socket.IO dashboard_update Photos Broadcast ---');
    await new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'your_secret_token' },
        reconnection: false,
        timeout: 3000
      });

      socket.on('connect', () => {
        // Toggle photo back on to trigger broadcast
        makeRequest(`/api/admin/photos/${photoId}`, 'PATCH', {
          show_in_screensaver: 1
        });
      });

      socket.on('dashboard_update', (data) => {
        assert(Array.isArray(data.photos), 'dashboard_update payload includes photos array');
        const found = data.photos.find((p) => p.id === photoId);
        if (found) {
          assert(true, 'Socket received real-time broadcast with newly enabled screensaver photo');
          socket.disconnect();
          resolve();
        }
      });

      socket.on('connect_error', reject);
    });

    // Cleanup photo
    const deleteRes = await makeRequest(`/api/admin/photos/${photoId}`, 'DELETE');
    assert(deleteRes.statusCode === 200 && deleteRes.json.ok, 'DELETE /api/admin/photos/:id deleted photo');

  } catch (err) {
    console.error('Phase 5 test error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL PHASE 5 TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

runPhase5Tests();
