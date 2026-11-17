const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const testDbPath = path.join(__dirname, '../data/test-security-fixes.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${testDbPath}${suffix}`;
  if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
}
process.env.DB_PATH = testDbPath;
process.env.DASHBOARD_TOKEN = 'test_dash_token_9876';
process.env.ADMIN_PASS = 'test_admin_pass_9876';

const { server } = require('../src/server');
const { validateExternalUrl } = require('../src/services/calendar');

function request(port, reqPath, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, headers: reqHeaders },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runSecurityTests() {
  const port = 3999;
  await new Promise((resolve) => server.listen(port, resolve));
  const adminAuthHeader = 'Basic ' + Buffer.from('admin:test_admin_pass_9876').toString('base64');

  try {
    // 1. Auth bypass fixes: unauthenticated requests must be rejected
    const dashNoToken = await request(port, '/api/dashboard');
    assert.strictEqual(dashNoToken.statusCode, 403, 'GET /api/dashboard without token must return 403');

    const redeemNoToken = await request(port, '/api/rewards/redeem', 'POST', { profile_id: 1, reward_id: 1 });
    assert.strictEqual(redeemNoToken.statusCode, 403, 'POST /api/rewards/redeem without token must return 403');

    const settingsNoToken = await request(port, '/api/settings');
    assert.strictEqual(settingsNoToken.statusCode, 403, 'GET /api/settings without token must return 403');

    const indexNoToken = await request(port, '/index.html');
    assert.strictEqual(indexNoToken.statusCode, 403, 'GET /index.html without token must return 403');

    const uploadsNoToken = await request(port, '/uploads/photos/screen-test.jpg');
    assert.strictEqual(uploadsNoToken.statusCode, 403, 'GET /uploads/photos/* without token must return 403');

    const weatherNoToken = await request(port, '/api/weather');
    assert.strictEqual(weatherNoToken.statusCode, 403, 'GET /api/weather without token must return 403');

    // 2. Security headers & cookie issuance on GET /?token=...
    const rootOk = await request(port, '/?token=test_dash_token_9876');
    assert.strictEqual(rootOk.statusCode, 200, 'GET /?token=... must return 200');
    assert.strictEqual(rootOk.headers['x-content-type-options'], 'nosniff', 'X-Content-Type-Options header must be nosniff');
    assert.strictEqual(rootOk.headers['referrer-policy'], 'no-referrer', 'Referrer-Policy header must be no-referrer');
    const setCookie = Array.isArray(rootOk.headers['set-cookie']) ? rootOk.headers['set-cookie'].join(';') : (rootOk.headers['set-cookie'] || '');
    assert(setCookie.includes('auth_token=test_dash_token_9876'), 'GET /?token=... must set auth_token cookie');

    // Cookie-authenticated access to /api/dashboard and /api/settings
    const dashWithCookie = await request(port, '/api/dashboard', 'GET', null, {
      Cookie: 'auth_token=test_dash_token_9876'
    });
    assert.strictEqual(dashWithCookie.statusCode, 200, 'GET /api/dashboard with auth_token cookie must return 200');
    const dashJson = JSON.parse(dashWithCookie.body);
    assert.strictEqual(dashJson.settings.https_cert_path, undefined, 'Public dashboard settings must not expose https_cert_path');
    assert.strictEqual(dashJson.settings.https_key_path, undefined, 'Public dashboard settings must not expose https_key_path');

    // 3. Admin settings allowlist must block https_cert_path / https_key_path overrides
    const settingsRes = await request(port, '/api/admin/settings', 'POST', {
      https_cert_path: '/etc/passwd',
      https_key_path: '/etc/shadow',
      language: 'en'
    }, { Authorization: adminAuthHeader });
    assert.strictEqual(settingsRes.statusCode, 200);
    const settingsBody = JSON.parse(settingsRes.body);
    assert.notStrictEqual(settingsBody.settings.https_cert_path, '/etc/passwd', 'https_cert_path must not be writable via admin settings');
    assert.notStrictEqual(settingsBody.settings.https_key_path, '/etc/shadow', 'https_key_path must not be writable via admin settings');

    // 4. Profile librus_password must be redacted from admin API responses
    const createProfRes = await request(port, '/api/admin/profiles', 'POST', {
      name: 'SecTestKid',
      librus_login: 'kidlogin',
      librus_password: 'TopSecretPassword123'
    }, { Authorization: adminAuthHeader });
    assert.strictEqual(createProfRes.statusCode, 200);
    const createdProf = JSON.parse(createProfRes.body).profile;
    assert.strictEqual(createdProf.librus_password, undefined, 'POST /api/admin/profiles must redact librus_password');
    assert.strictEqual(createdProf.has_librus_password, true, 'POST /api/admin/profiles must set has_librus_password=true');

    const listProfRes = await request(port, '/api/admin/profiles', 'GET', null, { Authorization: adminAuthHeader });
    const profList = JSON.parse(listProfRes.body);
    const found = profList.find(p => p.name === 'SecTestKid');
    assert(found && found.librus_password === undefined && found.has_librus_password === true, 'GET /api/admin/profiles must redact librus_password');

    // 5. SSRF URL validation
    for (const badUrl of [
      'http://127.0.0.1:3000/cal.ics',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/internal.ics',
      'http://192.168.1.1/cal.ics',
      'http://localhost/cal.ics',
      'file:///etc/passwd'
    ]) {
      let rejected = false;
      try {
        await validateExternalUrl(badUrl);
      } catch (e) {
        rejected = true;
      }
      assert(rejected, `SSRF check must reject ${badUrl}`);
    }

    const ssrfFeedRes = await request(port, '/api/admin/calendar/feeds', 'POST', {
      name: 'SSRF Test',
      ical_url: 'http://169.254.169.254/computeMetadata/v1/'
    }, { Authorization: adminAuthHeader });
    assert.strictEqual(ssrfFeedRes.statusCode, 400, 'POST /api/admin/calendar/feeds must reject metadata IP with 400');

    console.log('[PASS] All security regression checks passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${testDbPath}${suffix}`;
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
    }
  }
}

runSecurityTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[FAIL]', err);
    process.exit(1);
  });
