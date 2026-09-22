const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { server } = require('../src/server');

async function runPhase1Tests() {
  const testPort = 3911;

  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Phase 1 Test Server running on port ${testPort}`);

  function makeRequest(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: testPort,
          path,
          method: 'GET',
          headers
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        }
      );
      req.on('error', reject);
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
    console.log('\n--- 1. Root Route Security (403 Enforcement) ---');
    const noToken = await makeRequest('/');
    assert(noToken.statusCode === 403, `GET / without token returns 403 (got ${noToken.statusCode})`);

    const badToken = await makeRequest('/?token=incorrect_token');
    assert(badToken.statusCode === 403, `GET /?token=incorrect_token returns 403 (got ${badToken.statusCode})`);

    const goodToken = await makeRequest('/?token=your_secret_token');
    assert(goodToken.statusCode === 200, `GET /?token=your_secret_token returns 200 (got ${goodToken.statusCode})`);
    assert(goodToken.body.includes('Smart Home Kiosk Dashboard'), 'Dashboard HTML returned');
    assert(goodToken.body.includes('currentTime'), 'Vue clock logic present');
    assert(goodToken.body.includes('isSleeping'), 'Vue sleep logic present');

    console.log('\n--- 2. Admin Routes Security (express-basic-auth) ---');
    const noAdminAuth = await makeRequest('/admin');
    assert(noAdminAuth.statusCode === 401, `GET /admin without auth returns 401 (got ${noAdminAuth.statusCode})`);
    assert(!!noAdminAuth.headers['www-authenticate'], 'WWW-Authenticate challenge header present');

    const badAdminAuth = await makeRequest('/admin', {
      authorization: 'Basic ' + Buffer.from('admin:wrong_password').toString('base64')
    });
    assert(badAdminAuth.statusCode === 401, `GET /admin with wrong password returns 401 (got ${badAdminAuth.statusCode})`);

    const goodAdminAuth = await makeRequest('/admin', {
      authorization: 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64')
    });
    assert(goodAdminAuth.statusCode === 200, `GET /admin with valid credentials returns 200 (got ${goodAdminAuth.statusCode})`);

    const noApiAdmin = await makeRequest('/api/admin/ping');
    assert(noApiAdmin.statusCode === 401, `GET /api/admin/ping without auth returns 401 (got ${noApiAdmin.statusCode})`);

    const goodApiAdmin = await makeRequest('/api/admin/ping', {
      authorization: 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64')
    });
    assert(goodApiAdmin.statusCode === 200, `GET /api/admin/ping with valid credentials returns 200 (got ${goodApiAdmin.statusCode})`);
    const pingJson = JSON.parse(goodApiAdmin.body);
    assert(pingJson.admin === true, 'Admin API returned { admin: true }');

    console.log('\n--- 3. Socket.IO Token Authentication ---');
    await new Promise((resolve) => {
      const badSocket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'invalid_socket_token' },
        reconnection: false,
        timeout: 1500
      });
      badSocket.on('connect_error', (err) => {
        assert(err.message.includes('invalid dashboard token'), 'Socket with invalid token rejected: ' + err.message);
        badSocket.disconnect();
        resolve();
      });
      badSocket.on('connect', () => {
        assert(false, 'Socket without valid token connected unexpectedly');
        badSocket.disconnect();
        resolve();
      });
    });

    await new Promise((resolve) => {
      const goodSocket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'your_secret_token' },
        reconnection: false,
        timeout: 2000
      });
      goodSocket.on('connect', () => {
        assert(true, 'Socket with your_secret_token connected successfully');
      });
      goodSocket.on('system:info', (data) => {
        assert(data.status === 'connected', 'Received system:info greeting event');
        goodSocket.disconnect();
        resolve();
      });
      goodSocket.on('connect_error', (err) => {
        assert(false, 'Valid socket failed to connect: ' + err.message);
        goodSocket.disconnect();
        resolve();
      });
    });

  } catch (err) {
    console.error('Test execution error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL PHASE 1 TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

runPhase1Tests();
