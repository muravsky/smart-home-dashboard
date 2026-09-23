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
      avatar_value: '🚀'
    });
    assert(createProfileRes.statusCode === 200 && createProfileRes.json.ok, 'POST /api/admin/profiles created profile');
    const profileId = createProfileRes.json.profile.id;
    assert(createProfileRes.json.profile.avatar_value === '🚀', 'Built-in avatar emoji saved accurately');

    // Update Profile
    const updateProfileRes = await makeRequest(`/api/admin/profiles/${profileId}`, 'PATCH', {
      name: 'Oliver Star',
      color: '#0284c7'
    });
    assert(updateProfileRes.statusCode === 200 && updateProfileRes.json.profile.name === 'Oliver Star', 'PATCH /api/admin/profiles/:id updated name');

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

    // Toggle Item Checked
    const toggleItemRes = await makeRequest(`/api/admin/lists/${listId}/items/${itemId}/toggle`, 'PATCH', {
      checked: true
    });
    assert(toggleItemRes.statusCode === 200 && toggleItemRes.json.item.checked === 1, 'Toggle item checked status');

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
