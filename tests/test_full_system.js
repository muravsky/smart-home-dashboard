const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { server, io } = require('../src/server');

async function testFullSystem() {
  const testPort = 3944;

  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Full System Test running on port ${testPort}`);

  function makeRequest(path, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64');
      const reqHeaders = {
        authorization: authHeader,
        ...headers
      };
      if (body) {
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
            try { parsed = JSON.parse(data); } catch(e) {}
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
    console.log('\n--- 1. Admin Console & CRUD Endpoints ---');
    
    // Check Admin HTML
    const adminPage = await makeRequest('/admin');
    assert(adminPage.statusCode === 200, 'GET /admin returns 200 with credentials');
    assert(adminPage.raw.includes('SMART HOME ADMIN'), 'Admin Console HTML rendered');
    assert(adminPage.raw.includes('GEMINI 1.5 FLASH SIMULATOR'), 'Simulator present in Admin UI');

    // Add Note via Admin API
    const newNote = await makeRequest('/api/admin/notes', 'POST', { content: 'Automated test note' });
    assert(newNote.statusCode === 200 && newNote.json.ok, 'POST /api/admin/notes succeeded');
    const noteId = newNote.json.note.id;

    // Delete Note via Admin API
    const delNote = await makeRequest(`/api/admin/notes/${noteId}`, 'DELETE');
    assert(delNote.statusCode === 200 && delNote.json.ok, 'DELETE /api/admin/notes/:id succeeded');

    // Add Task via Admin API
    const newTask = await makeRequest('/api/admin/tasks', 'POST', {
      title: 'Water the plants',
      assignee: 'maria',
      reward: 15
    });
    assert(newTask.statusCode === 200 && newTask.json.ok, 'POST /api/admin/tasks succeeded');
    const taskId = newTask.json.task.id;

    // Patch Task Status
    const patchTask = await makeRequest(`/api/admin/tasks/${taskId}`, 'PATCH', { status: 'completed' });
    assert(patchTask.statusCode === 200 && patchTask.json.ok, 'PATCH /api/admin/tasks/:id succeeded');

    // Verify task is now completed
    const dataRes = await makeRequest('/api/admin/data');
    const taskInDb = dataRes.json.tasks.find((t) => t.id === taskId);
    assert(taskInDb && taskInDb.status === 'completed', 'Task status updated to completed in SQLite');

    // Delete Task
    const delTask = await makeRequest(`/api/admin/tasks/${taskId}`, 'DELETE');
    assert(delTask.statusCode === 200 && delTask.json.ok, 'DELETE /api/admin/tasks/:id succeeded');

    console.log('\n--- 2. Tablet Kiosk Interactive Task Toggle via Socket ---');
    // Create a temporary task to test socket toggle
    const socketTaskRes = await makeRequest('/api/admin/tasks', 'POST', {
      title: 'Test Socket Toggle',
      assignee: 'kiosk',
      reward: 5
    });
    const socketTaskId = socketTaskRes.json.task.id;

    await new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'your_secret_token' },
        reconnection: false,
        timeout: 3000
      });

      socket.on('connect', () => {
        // Emit task:toggle from tablet
        socket.emit('task:toggle', { id: socketTaskId, status: 'completed' });
      });

      socket.on('dashboard_update', (payload) => {
        const found = payload.tasks.find((t) => t.id === socketTaskId);
        if (found && found.status === 'completed') {
          assert(true, 'Socket received real-time broadcast of task completion toggled from tablet');
          socket.disconnect();
          resolve();
        }
      });

      socket.on('connect_error', reject);
    });

    // Cleanup
    await makeRequest(`/api/admin/tasks/${socketTaskId}`, 'DELETE');

  } catch (err) {
    console.error('Test error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL FULL SYSTEM TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

testFullSystem();
