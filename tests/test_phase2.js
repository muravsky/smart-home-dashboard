const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { server, io } = require('../src/server');
const { insertNote, insertTask, getDashboardData, getNotes, getTasks } = require('../src/db');
const { SYSTEM_PROMPT } = require('../src/services/gemini');

async function runPhase2Tests() {
  const testPort = 3922;

  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Phase 2 Test Server running on port ${testPort}`);

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
    // 1. SQLite Database Schema & Helpers
    console.log('\n--- 1. SQLite Database Tests ---');
    const note1 = insertNote('Buy fresh organic milk and ground coffee');
    assert(note1.id > 0, `Note inserted with ID: ${note1.id}`);
    assert(note1.content === 'Buy fresh organic milk and ground coffee', 'Note content saved accurately');

    const task1 = insertTask({
      assignee: 'alex',
      title: 'Clean the garage and sort recycling',
      reward: 50,
      status: 'pending'
    });
    assert(task1.id > 0, `Task inserted with ID: ${task1.id}`);
    assert(task1.assignee === 'alex', 'Task assignee saved');
    assert(task1.reward === 50, 'Task reward saved');

    const data = getDashboardData();
    assert(Array.isArray(data.notes) && data.notes.length > 0, 'getDashboardData returned notes array');
    assert(Array.isArray(data.tasks) && data.tasks.length > 0, 'getDashboardData returned tasks array');
    assert(data.notes[0].content === note1.content, 'Latest note appears in dashboard data');

    // 2. Gemini System Prompt & JSON Schema
    console.log('\n--- 2. Gemini System Prompt Verification ---');
    assert(
      SYSTEM_PROMPT.includes('{ "notes": ["string"], "tasks": [{ "assignee": "string", "title": "string", "reward": number }] }'),
      'Gemini system prompt enforces exact JSON schema'
    );

    // 3. Socket.IO Real-Time dashboard_update
    console.log('\n--- 3. Socket.IO dashboard_update Push Tests ---');
    await new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${testPort}`, {
        auth: { token: 'your_secret_token' },
        reconnection: false,
        timeout: 3000
      });

      let receivedInitial = false;

      socket.on('dashboard_update', (payload) => {
        if (!receivedInitial) {
          receivedInitial = true;
          assert(Array.isArray(payload.notes), 'Socket received initial dashboard_update notes');
          assert(Array.isArray(payload.tasks), 'Socket received initial dashboard_update tasks');

          // Now trigger a new note insertion and broadcast to test live update
          const newNote = insertNote('Check heating boiler pressure');
          const latestData = getDashboardData();
          io.emit('dashboard_update', latestData);
        } else {
          // Received updated broadcast
          const found = payload.notes.some((n) => n.content === 'Check heating boiler pressure');
          assert(found, 'Socket received live broadcast with new note');
          socket.disconnect();
          resolve();
        }
      });

      socket.on('connect_error', (err) => {
        reject(err);
      });
    });

  } catch (err) {
    console.error('Phase 2 test execution error:', err);
    failures++;
  } finally {
    server.close();
  }

  if (failures === 0) {
    console.log('\n=== ALL PHASE 2 TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} TESTS FAILED ===\n`);
    process.exit(1);
  }
}

runPhase2Tests();
