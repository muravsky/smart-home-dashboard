const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { server } = require('../src/server');

async function runPhase4Tests() {
  const testPort = 3966;

  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Phase 4 Test Server running on port ${testPort}`);

  function makeRequest(path, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64');
      const reqHeaders = {
        authorization: authHeader,
        ...headers
      };
      if (body && typeof body === 'object') {
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
      if (body) req.write(JSON.stringify(body));
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
    console.log('\n--- 1. Widget Layouts Query API ---');
    const getLayoutsRes = await makeRequest('/api/layouts');
    assert(getLayoutsRes.statusCode === 200, 'GET /api/layouts returns 200');
    assert(Array.isArray(getLayoutsRes.json), 'GET /api/layouts returned an array of widgets');
    assert(getLayoutsRes.json.length >= 3, `Found ${getLayoutsRes.json.length} default seeded layout widgets`);

    // Verify Page 0 and Page 1 exist
    const page0Widgets = getLayoutsRes.json.filter((w) => w.page === 0);
    const page1Widgets = getLayoutsRes.json.filter((w) => w.page === 1);
    assert(page0Widgets.length > 0, 'Page 0 has seeded widgets (Clock, Tasks, List, Notes)');
    assert(page1Widgets.length > 0, 'Page 1 has seeded widgets (Weather, Timer, Tasks)');

    console.log('\n--- 2. Widget Layouts Save API ---');
    const customLayouts = [
      { page: 0, widget_type: 'clock', x: 0, y: 0, w: 12, h: 2, config: { showSeconds: true }, position: 0 },
      { page: 0, widget_type: 'tasks', x: 0, y: 2, w: 6, h: 2, config: { title: 'Test Tasks' }, position: 1 },
      { page: 1, widget_type: 'weather', x: 0, y: 0, w: 6, h: 2, config: {}, position: 0 }
    ];

    const saveLayoutsRes = await makeRequest('/api/admin/layouts', 'POST', {
      layouts: customLayouts
    });
    assert(saveLayoutsRes.statusCode === 200 && saveLayoutsRes.json.ok, 'POST /api/admin/layouts saved layout');
    assert(saveLayoutsRes.json.layouts.length === 3, 'Saved exactly 3 layout widgets');

    console.log('\n--- 3. Socket.IO layout:save Event & Real-Time Broadcast ---');
    await new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'your_secret_token' },
        reconnection: false,
        timeout: 3000
      });

      socket.on('connect', () => {
        // Emit layout:save from tablet kiosk
        socket.emit('layout:save', [
          { page: 0, widget_type: 'clock', x: 0, y: 0, w: 12, h: 2, config: {}, position: 0 },
          { page: 0, widget_type: 'timer', x: 0, y: 2, w: 6, h: 2, config: {}, position: 1 },
          { page: 1, widget_type: 'notes', x: 0, y: 0, w: 12, h: 2, config: {}, position: 0 }
        ]);
      });

      socket.on('dashboard_update', (data) => {
        assert(Array.isArray(data.layouts), 'dashboard_update payload includes layouts array');
        const hasTimer = data.layouts.some((l) => l.widget_type === 'timer' && l.page === 0);
        if (hasTimer) {
          assert(true, 'Socket received real-time broadcast of updated layout saved from tablet');
          socket.disconnect();
          resolve();
        }
      });

      socket.on('connect_error', reject);
    });

  } catch (err) {
    console.error('Phase 4 test error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL PHASE 4 BACKEND TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

runPhase4Tests();
