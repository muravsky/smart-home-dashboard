const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { server } = require('../src/server');

async function runPhase3Tests() {
  const testPort = 3955;

  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Phase 3 Test Server running on port ${testPort}`);

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
    console.log('\n--- 1. Profile Management API ---');
    // Create Profile
    const createProfileRes = await makeRequest('/api/admin/profiles', 'POST', {
      name: 'Oliver',
      color: '#38bdf8',
      avatar_type: 'builtin',
      avatar_value: '🚀',
      language: 'ru'
    });
    assert(createProfileRes.statusCode === 200 && createProfileRes.json.ok, 'POST /api/admin/profiles created profile');
    const profileId = createProfileRes.json.profile.id;
    assert(createProfileRes.json.profile.avatar_value === '🚀', 'Built-in avatar emoji saved accurately');
    assert(createProfileRes.json.profile.language === 'ru', 'Profile language stored correctly');

    // Update Profile
    const updateProfileRes = await makeRequest(`/api/admin/profiles/${profileId}`, 'PATCH', {
      name: 'Oliver Star',
      color: '#0284c7',
      language: 'uk'
    });
    assert(updateProfileRes.statusCode === 200 && updateProfileRes.json.profile.name === 'Oliver Star', 'PATCH /api/admin/profiles/:id updated name');
    assert(updateProfileRes.json.profile.language === 'uk', 'PATCH /api/admin/profiles/:id updated language');

    const globalSettingsRes = await makeRequest('/api/admin/settings', 'POST', {
      language: 'pl'
    });
    assert(globalSettingsRes.statusCode === 200 && globalSettingsRes.json.settings.language === 'pl', 'Global language setting stored correctly');

    console.log('\n--- 1b. Schedule Management API ---');
    const createScheduleRes = await makeRequest('/api/admin/schedules', 'POST', {
      profile_id: profileId,
      name: 'Oliver Weekly Schedule',
      schedule: [
        { day: 'Mon', lessons: [{ number: 1, start: '08:30', end: '09:15', name: 'Math', room: 'A-101' }] },
        { day: 'Tue', lessons: [{ number: 1, start: '08:30', end: '09:15', name: 'Science', room: 'B-204' }] }
      ]
    });
    assert(createScheduleRes.statusCode === 200 && createScheduleRes.json.ok, 'POST /api/admin/schedules created schedule');
    const scheduleId = createScheduleRes.json.schedule.id;

    const updateScheduleRes = await makeRequest(`/api/admin/schedules/${scheduleId}`, 'PATCH', {
      name: 'Oliver Weekly Schedule Updated',
      schedule: [
        { day: 'Mon', lessons: [{ number: 1, start: '08:30', end: '09:15', name: 'Math', room: 'A-101' }, { number: 2, start: '09:25', end: '10:10', name: 'English', room: 'E-115' }] }
      ]
    });
    assert(updateScheduleRes.statusCode === 200 && updateScheduleRes.json.schedule.name === 'Oliver Weekly Schedule Updated', 'PATCH /api/admin/schedules/:id updated schedule metadata');

    console.log('\n--- 2. List & List Items Management API ---');
    // Create Custom Shopping List for Oliver
    const createListRes = await makeRequest('/api/admin/lists', 'POST', {
      name: 'Oliver School Supplies',
      type: 'custom',
      profile_id: profileId,
      color: '#f59e0b',
      icon: '🎒'
    });
    assert(createListRes.statusCode === 200 && createListRes.json.ok, 'POST /api/admin/lists created custom list');
    const listId = createListRes.json.list.id;

    // Add Item to List
    const addItemRes = await makeRequest(`/api/admin/lists/${listId}/items`, 'POST', {
      content: 'Colored pencils 24pk',
      assignee_profile_id: profileId,
      reward: 5
    });
    assert(addItemRes.statusCode === 200 && addItemRes.json.ok, 'POST /api/admin/lists/:id/items added item');
    const itemId = addItemRes.json.item.id;

    // Patch list metadata
    const patchListRes = await makeRequest(`/api/admin/lists/${listId}`, 'PATCH', {
      name: 'Oliver School Supplies Updated',
      type: 'shopping',
      color: '#f97316',
      icon: '🧰',
      profile_id: profileId
    });
    assert(patchListRes.statusCode === 200 && patchListRes.json.ok && patchListRes.json.list.type === 'shopping', 'PATCH /api/admin/lists/:id updated list type and metadata');

    // Patch item fields
    const patchItemRes = await makeRequest(`/api/admin/lists/${listId}/items/${itemId}`, 'PATCH', {
      content: 'Colored pencils 24pk (updated)',
      assignee_profile_id: profileId,
      reward: 12,
      due_date: '2026-09-30',
      due_time: '15:30',
      recurrence: 'weekly',
      recurrence_interval: 2,
      recurrence_days: [1, 3]
    });
    assert(patchItemRes.statusCode === 200 && patchItemRes.json.ok && patchItemRes.json.item.content.includes('updated') && patchItemRes.json.item.recurrence === 'weekly', 'PATCH /api/admin/lists/:listId/items/:itemId updated item fields');

    // Toggle Item Checked
    const toggleItemRes = await makeRequest(`/api/admin/lists/${listId}/items/${itemId}/toggle`, 'PATCH', {
      checked: true
    });
    assert(toggleItemRes.statusCode === 200 && toggleItemRes.json.item.checked === 0, 'Toggle item checked status on recurring item resets completion instead of staying checked');

    console.log('\n--- 3. Socket.IO Real-Time Lists & Profiles Synchronization ---');
    await new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'your_secret_token' },
        reconnection: false,
        timeout: 3000
      });

      socket.on('connect', () => {
        // Emit list:item:add from tablet client
        socket.emit('list:item:add', {
          listId,
          content: 'Sketchbook A4',
          assigneeProfileId: profileId,
          reward: 10
        });
      });

      socket.on('dashboard_update', (data) => {
        assert(Array.isArray(data.profiles), 'dashboard_update includes profiles array');
        assert(Array.isArray(data.lists), 'dashboard_update includes lists array');

        const targetList = data.lists.find((l) => l.id === listId);
        if (targetList) {
          const foundNewItem = targetList.items.find((i) => i.content === 'Sketchbook A4');
          if (foundNewItem) {
            assert(true, 'Socket received real-time broadcast of list item added from tablet');
            socket.disconnect();
            resolve();
          }
        }
      });

      socket.on('connect_error', reject);
    });

    // Cleanup
    if (scheduleId) await makeRequest(`/api/admin/schedules/${scheduleId}`, 'DELETE');
    await makeRequest(`/api/admin/lists/${listId}`, 'DELETE');
    await makeRequest(`/api/admin/profiles/${profileId}`, 'DELETE');

  } catch (err) {
    console.error('Phase 3 test error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL PHASE 3 TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

runPhase3Tests();
