const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { server, app } = require('../src/server');

async function runTests() {
  const testPort = 3899;
  
  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Test server running on port ${testPort}`);

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
    // 1. Health check
    console.log('\n--- 1. Health Check Endpoint ---');
    const health = await makeRequest('/api/health');
    assert(health.statusCode === 200, `Healthcheck returned 200 (got ${health.statusCode})`);
    const healthBody = JSON.parse(health.body);
    assert(healthBody.status === 'healthy', 'Healthcheck body reports healthy');

    // 2. Dashboard without token
    console.log('\n--- 2. Dashboard Token Security ---');
    const noToken = await makeRequest('/');
    assert(noToken.statusCode === 401, `GET / without token returns 401 (got ${noToken.statusCode})`);

    const badToken = await makeRequest('/?token=wrongsecret');
    assert(badToken.statusCode === 401, `GET /?token=wrongsecret returns 401 (got ${badToken.statusCode})`);

    const validToken = await makeRequest('/?token=secret123');
    assert(validToken.statusCode === 200, `GET /?token=secret123 returns 200 (got ${validToken.statusCode})`);
    assert(validToken.body.includes('Smart Home Kiosk'), 'Dashboard HTML returned for valid token');

    // 3. Admin Basic Auth
    console.log('\n--- 3. Admin Basic Auth Security ---');
    const noAdminAuth = await makeRequest('/admin');
    assert(noAdminAuth.statusCode === 401, `GET /admin without auth returns 401 (got ${noAdminAuth.statusCode})`);
    assert(!!noAdminAuth.headers['www-authenticate'], 'WWW-Authenticate header present');

    const badAdminAuth = await makeRequest('/admin', {
      authorization: 'Basic ' + Buffer.from('admin:wrongpass').toString('base64')
    });
    assert(badAdminAuth.statusCode === 401, `GET /admin with wrong credentials returns 401 (got ${badAdminAuth.statusCode})`);

    const validAdminAuth = await makeRequest('/admin', {
      authorization: 'Basic ' + Buffer.from('admin:adminpass').toString('base64')
    });
    assert(validAdminAuth.statusCode === 200, `GET /admin with valid credentials returns 200 (got ${validAdminAuth.statusCode})`);
    assert(validAdminAuth.body.includes('Admin Control Panel'), 'Admin panel HTML returned');

    // 4. Socket.IO Authentication
    console.log('\n--- 4. Socket.IO Token Authentication ---');
    await new Promise((resolve) => {
      const badSocket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'badtoken' },
        reconnection: false,
        timeout: 1500
      });
      badSocket.on('connect_error', (err) => {
        assert(err.message.includes('invalid token'), 'Socket with invalid token rejected: ' + err.message);
        badSocket.disconnect();
        resolve();
      });
      badSocket.on('connect', () => {
        assert(false, 'Socket without valid token should NOT connect');
        badSocket.disconnect();
        resolve();
      });
    });

    await new Promise((resolve) => {
      const goodSocket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'secret123' },
        reconnection: false,
        timeout: 2000
      });
      goodSocket.on('connect', () => {
        assert(true, 'Socket with valid token connected successfully');
      });
      goodSocket.on('system:info', (data) => {
        assert(data.status === 'connected', 'Received system:info greeting on socket');
        goodSocket.disconnect();
        resolve();
      });
      goodSocket.on('connect_error', (err) => {
        assert(false, 'Valid socket connection failed: ' + err.message);
        goodSocket.disconnect();
        resolve();
      });
    });

  } catch (err) {
    console.error('Unexpected test exception:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL STEP 1 SECURITY & SERVER TESTS PASSED ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

runTests();
