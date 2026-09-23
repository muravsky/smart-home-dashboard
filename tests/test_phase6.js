const http = require('http');
const { server } = require('../src/server');

async function runPhase6Tests() {
  const testPort = 3988;
  const { io: ioClient } = require('socket.io-client');

  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Phase 6 Test Server running on port ${testPort}`);

  function makeRequest(path, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64');
      const reqHeaders = {
        authorization: authHeader,
        'content-type': 'application/json',
        ...headers
      };

      const req = http.request(
        { hostname: '127.0.0.1', port: testPort, path, method, headers: reqHeaders },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch (e) {}
            resolve({ statusCode: res.statusCode, json: parsed });
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
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
    console.log('\n--- 1. Calendar Events REST API ---');
    const getEventsRes = await makeRequest('/api/admin/calendar/events');
    assert(getEventsRes.statusCode === 200, 'GET /api/admin/calendar/events returns 200');
    assert(Array.isArray(getEventsRes.json), 'GET /api/admin/calendar/events returns array');

    const todayStr = new Date().toISOString().slice(0, 10);
    const createRes = await makeRequest('/api/admin/calendar/events', 'POST', {
      title: 'Test Event Phase 6',
      description: 'Calendar test',
      start_datetime: `${todayStr}T14:00:00`,
      end_datetime: `${todayStr}T15:00:00`,
      all_day: 0,
      color: '#34d399'
    });
    assert(createRes.statusCode === 200 && createRes.json.ok, 'POST /api/admin/calendar/events creates event');
    assert(createRes.json.event.title === 'Test Event Phase 6', 'Event title saved correctly');
    assert(createRes.json.event.start_datetime === `${todayStr}T14:00:00`, 'Event start_datetime saved correctly');
    const eventId = createRes.json.event.id;

    // Public endpoint security
    const noTokenRes = await makeRequest('/api/calendar/events', 'GET', null, { authorization: '' });
    assert(noTokenRes.statusCode === 403, 'GET /api/calendar/events without token returns 403');

    const tokenRes = await makeRequest(`/api/calendar/events?token=your_secret_token`, 'GET', null, { authorization: '' });
    assert(tokenRes.statusCode === 200, 'GET /api/calendar/events?token returns 200');
    assert(Array.isArray(tokenRes.json), 'GET /api/calendar/events returns array');

    console.log('\n--- 2. Calendar Feeds CRUD ---');
    const getFeedsRes = await makeRequest('/api/admin/calendar/feeds');
    assert(getFeedsRes.statusCode === 200, 'GET /api/admin/calendar/feeds returns 200');
    assert(Array.isArray(getFeedsRes.json), 'GET /api/admin/calendar/feeds returns array');

    // Create a feed with invalid URL to test DB insertion without network
    const createFeedRes = await makeRequest('/api/admin/calendar/feeds', 'POST', {
      name: 'Test Holiday Calendar',
      ical_url: 'https://example.com/holidays.ics',
      color: '#f59e0b',
      profile_id: null
    });
    assert(createFeedRes.statusCode === 200 && createFeedRes.json.ok, 'POST /api/admin/calendar/feeds creates feed');
    assert(createFeedRes.json.feed.name === 'Test Holiday Calendar', 'Feed name saved correctly');
    const feedId = createFeedRes.json.feed.id;

    const deleteFeedRes = await makeRequest(`/api/admin/calendar/feeds/${feedId}`, 'DELETE');
    assert(deleteFeedRes.statusCode === 200 && deleteFeedRes.json.ok, 'DELETE /api/admin/calendar/feeds/:id deletes feed');

    console.log('\n--- 3. getDashboardData includes events and feeds ---');
    const dashRes = await makeRequest(`/?token=your_secret_token`, 'GET', null, { authorization: '' });
    assert(dashRes.statusCode === 200, 'Dashboard page returns 200');

    // Check via socket
    await new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'your_secret_token' },
        reconnection: false,
        timeout: 3000
      });

      socket.on('connect', () => {
        // Trigger a broadcast by deleting an event
        makeRequest(`/api/admin/calendar/events/${eventId}`, 'DELETE');
      });

      socket.on('dashboard_update', (data) => {
        assert(Array.isArray(data.events), 'dashboard_update payload includes events array');
        assert(Array.isArray(data.feeds), 'dashboard_update payload includes feeds array');
        socket.disconnect();
        resolve();
      });

      socket.on('connect_error', reject);
    });

  } catch (err) {
    console.error('Phase 6 test error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL PHASE 6 TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

runPhase6Tests();
