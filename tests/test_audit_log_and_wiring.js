/**
 * tests/test_audit_log_and_wiring.js
 * Comprehensive integration tests for:
 * 1. Audit Log SQLite DB operations (insert, query with filters, clear)
 * 2. Audit Log Admin REST APIs (GET /api/admin/audit-logs, DELETE /api/admin/audit-logs)
 * 3. Telegram AI Action application (tasks created in list_items & tasks, shopping items, notes, calendar)
 * 4. Kiosk /api/message and Admin /api/admin/simulate-message audit trail recording
 * 5. Task completion via toggleListItemChecked (/done command wiring)
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const {
  db,
  insertAuditLog,
  getAuditLogs,
  clearAuditLogs,
  getLists,
  getListById,
  getTasks,
  getNotes,
  getCalendarEvents,
  insertProfile,
  toggleListItemChecked,
  getProfiles
} = require('../src/db');
const { applyParsedGeminiActions, getOrCreateDashboardList, resolveProfileIdFromName } = require('../src/bot');

function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

async function runTests() {
  console.log('=== STARTING AUDIT LOG & WIRING INTEGRATION TESTS ===\n');

  // --- 1. Audit Log SQLite Direct DB Operations ---
  console.log('--- 1. Direct DB Audit Log Operations ---');
  clearAuditLogs();
  assert.strictEqual(getAuditLogs().length, 0, 'Audit logs should be empty after clearAuditLogs()');
  pass('clearAuditLogs emptied table');

  insertAuditLog({
    source: 'telegram_text',
    sender_id: '123456',
    sender_name: 'Alice',
    message_type: 'text',
    raw_input: 'Add milk to shopping list',
    parsed_payload: { shopping_items: [{ content: 'Milk' }] },
    action_taken: 'Added 1 shopping item(s)',
    status: 'success'
  });

  insertAuditLog({
    source: 'kiosk_dictation',
    sender_name: 'Bob',
    message_type: 'voice',
    raw_input: 'Clean bedroom',
    parsed_payload: { tasks: [{ title: 'Clean bedroom' }] },
    action_taken: 'Created 1 task(s)',
    status: 'success'
  });

  insertAuditLog({
    source: 'telegram_command',
    sender_id: '999999',
    sender_name: 'Eve',
    message_type: 'command',
    raw_input: '/unknown',
    action_taken: 'Blocked by TELEGRAM_WHITELIST_IDS',
    status: 'blocked',
    error_message: 'Sender 999999 not in whitelist'
  });

  const allLogs = getAuditLogs();
  assert.strictEqual(allLogs.length, 3, 'Should have 3 audit logs inserted');
  pass('Inserted 3 audit logs with distinct sources and statuses');

  const filteredBySource = getAuditLogs({ source: 'telegram_text' });
  assert.strictEqual(filteredBySource.length, 1);
  assert.strictEqual(filteredBySource[0].sender_name, 'Alice');
  pass('Filtered logs by source correctly');

  const filteredByStatus = getAuditLogs({ status: 'blocked' });
  assert.strictEqual(filteredByStatus.length, 1);
  assert.strictEqual(filteredByStatus[0].sender_id, '999999');
  pass('Filtered logs by status correctly');

  // Test JSON parsing in helper
  assert.deepStrictEqual(JSON.parse(filteredBySource[0].parsed_payload), { shopping_items: [{ content: 'Milk' }] });
  pass('Parsed payload parsed back to JS object correctly');

  // --- 2. AI Action Application Wiring (applyParsedGeminiActions) ---
  console.log('\n--- 2. AI Action Application Wiring ---');
  // Create a profile for test
  const uniqueName = 'Charlie_' + Date.now();
  const testProfile = insertProfile({
    name: uniqueName,
    avatar: '👦',
    color: '#3b82f6',
    language: 'en'
  });

  const mockGeminiOutput = {
    notes: ['Remember to water plants'],
    tasks: [
      {
        title: 'Walk the dog',
        assignee: uniqueName,
        reward: 15,
        due_date: 'tomorrow',
        recurrence: 'daily'
      }
    ],
    shopping_items: [
      { content: 'Apples' }
    ],
    calendar_events: [
      {
        title: 'Dentist appointment',
        date: '2026-10-15',
        time: '14:30',
        all_day: false
      }
    ],
    timer: { minutes: 10, action: 'start' }
  };

  let mockEmittedEvents = [];
  const mockIo = {
    emit: (event, data) => {
      mockEmittedEvents.push({ event, data });
    }
  };

  const result = await applyParsedGeminiActions(mockGeminiOutput, testProfile, mockIo);
  assert(result.summary.includes('Created 1 task(s)'), 'Summary should include created tasks');
  assert(result.summary.includes('Added 1 shopping item(s)'), 'Summary should include shopping item');
  assert(result.summary.includes('Scheduled 1 event(s)'), 'Summary should include calendar event');
  assert(result.summary.includes('Set timer for 10 min'), 'Summary should include timer');
  pass('applyParsedGeminiActions generated expected summary');

  // Verify task was inserted into list_items under 'tasks' list
  const tasksList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
  const taskItems = getListById(tasksList.id).items;
  const foundTaskItem = taskItems.find(i => i.content === 'Walk the dog');
  assert(foundTaskItem, 'Task must exist in list_items');
  assert.strictEqual(foundTaskItem.assignee_profile_id, testProfile.id, 'Assignee profile ID correctly mapped');
  assert.strictEqual(foundTaskItem.reward, 15, 'Reward points saved in list_item');
  assert.strictEqual(foundTaskItem.recurrence, 'daily', 'Recurrence saved');
  pass('Task created in list_items with assignee profile ID and reward');

  // Verify task also in legacy tasks table
  const legacyTasks = getTasks();
  const foundLegacy = legacyTasks.find(t => t.title === 'Walk the dog');
  assert(foundLegacy, 'Task must exist in legacy tasks table');
  assert.strictEqual(foundLegacy.reward, 15);
  pass('Task created in legacy tasks table for backward compatibility');

  // Verify shopping item was inserted in list_items under 'shopping' list
  const shopList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
  const shopItems = getListById(shopList.id).items;
  const foundShop = shopItems.find(i => i.content === 'Apples');
  assert(foundShop, 'Shopping item must exist in list_items');
  pass('Shopping item created in list_items');

  // Verify calendar event was inserted
  const calEvents = getCalendarEvents();
  const foundCal = calEvents.find(e => e.title === 'Dentist appointment');
  assert(foundCal, 'Calendar event must exist in calendar_events');
  pass('Calendar event created in calendar_events');

  // Verify socket timer event
  const timerEvent = mockEmittedEvents.find(e => e.event === 'timer:set');
  assert(timerEvent && timerEvent.data.minutes === 10, 'timer:set event emitted over socket');
  pass('Socket timer:set event emitted correctly');

  // --- 3. Task Completion /done Wiring ---
  console.log('\n--- 3. /done Task Completion Wiring ---');
  // Toggle the task checked status via toggleListItemChecked
  const toggled = toggleListItemChecked(foundTaskItem.id, true);
  // Because it was 'daily' recurrence, toggleListItemChecked advances next_recurrence and resets checked to 0
  assert(toggled, 'toggleListItemChecked returned updated item');
  assert.strictEqual(toggled.checked, 0, 'Recurring item resets checked to 0');
  const todayStr = new Date().toISOString().slice(0, 10);
  assert(toggled.due_date >= todayStr, `Recurring due_date (${toggled.due_date}) advanced to today or future (>= ${todayStr})`);
  pass('toggleListItemChecked properly processed recurring item');

  // Now create a non-recurring task item and toggle it
  const testOneTime = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
  const { insertListItem } = require('../src/db');
  const oneTimeItem = insertListItem({
    list_id: testOneTime.id,
    content: 'Take out trash',
    assignee_profile_id: testProfile.id,
    reward: 5,
    recurrence: 'none'
  });

  const checkedItem = toggleListItemChecked(oneTimeItem.id, true);
  assert.strictEqual(checkedItem.checked, 1, 'Non-recurring item stays checked=1 in SQLite');
  pass('toggleListItemChecked keeps non-recurring item checked=1 in DB');

  // --- 4. Server REST APIs (Audit Log & Message Handlers) ---
  console.log('\n--- 4. Server REST API & Audit Log Verification ---');
  const { server } = require('../src/server');
  const PORT = 3995;

  await new Promise(resolve => server.listen(PORT, resolve));
  const adminPass = process.env.ADMIN_PASS || 'your_admin_pass';
  const basicAuthHeader = 'Basic ' + Buffer.from('admin:' + adminPass).toString('base64');

  // 4a: GET /api/admin/audit-logs
  const auditRes = await fetchJson(`http://localhost:${PORT}/api/admin/audit-logs`, {
    headers: { 'Authorization': basicAuthHeader }
  });
  assert.strictEqual(auditRes.status, 200);
  assert(Array.isArray(auditRes.data), 'Should return logs array');
  assert(auditRes.data.length >= 3, 'Should contain at least 3 logs');
  pass('GET /api/admin/audit-logs returned 200 with logs array');

  // 4b: POST /api/admin/simulate-message
  const simRes = await fetchJson(`http://localhost:${PORT}/api/admin/simulate-message`, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: 'Remember to buy bread tomorrow',
      senderName: 'TestSimulator'
    })
  });
  assert.strictEqual(simRes.status, 500);
  pass('POST /api/admin/simulate-message caught missing API key and returned 500');

  // Check audit log for simulated message
  const simLogs = getAuditLogs({ source: 'admin_simulator' });
  assert(simLogs.length > 0, 'Admin simulator logged in audit_logs');
  assert.strictEqual(simLogs[0].sender_name, 'TestSimulator');
  assert.strictEqual(simLogs[0].status, 'error');
  assert(simLogs[0].error_message.includes('GEMINI_API_KEY'));
  pass('Admin simulator failure logged accurately in audit_logs');

  // 4c: DELETE /api/admin/audit-logs
  const deleteRes = await fetchJson(`http://localhost:${PORT}/api/admin/audit-logs`, {
    method: 'DELETE',
    headers: { 'Authorization': basicAuthHeader }
  });
  assert.strictEqual(deleteRes.status, 200);
  assert.strictEqual(deleteRes.data.ok, true);
  const remainingLogs = getAuditLogs();
  assert.strictEqual(remainingLogs.length, 0, 'Audit logs should be 0 after DELETE');
  pass('DELETE /api/admin/audit-logs successfully cleared logs');

  server.close();
  console.log('\n=== ALL AUDIT LOG & WIRING TESTS PASSED! ===');
  process.exit(0);
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

runTests().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
