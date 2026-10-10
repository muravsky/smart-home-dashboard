/**
 * tests/test_gemini_models_and_family_wiring.js
 * Verification for:
 * 1. Gemini Models endpoint & fallback listing (GET /api/admin/gemini/models)
 * 2. Gemini model selection persistence (settings.gemini_model & getGeminiModel())
 * 3. System prompt dynamic injection (family profiles & lists)
 * 4. Normalization of family vs individual assignments and recurrence
 * 5. Action application for specific people, entire family, and recurring tasks/groceries/events
 */

const assert = require('assert');
const http = require('http');
const {
  db,
  getSettings,
  updateSettings,
  getProfiles,
  insertProfile,
  getLists,
  getListById,
  getTasks,
  getCalendarEvents,
  insertCalendarFeed,
  deleteCalendarFeed
} = require('../src/db');
const {
  getGeminiModel,
  listAvailableGeminiModels,
  buildSystemPrompt,
  normalizeParsedGeminiPayload
} = require('../src/services/gemini');
const { applyParsedGeminiActions, getOrCreateDashboardList } = require('../src/bot');

function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

async function runTests() {
  console.log('=== STARTING GEMINI MODELS & FAMILY/RECURRING ACTIONS TESTS ===\n');

  // --- 1. Available Models Discovery ---
  console.log('--- 1. Models Discovery & Fallback ---');
  const models = await listAvailableGeminiModels(null);
  assert(Array.isArray(models), 'Models must be an array');
  assert(models.length > 0, 'Must return at least fallback models');
  assert(models.some(m => m.id.includes('flash')), 'Must include flash models in list');
  pass('listAvailableGeminiModels returned valid models array');

  // --- 2. Model Selection Configuration & Persistence ---
  console.log('\n--- 2. Model Selection Persistence ---');
  const initialModel = getGeminiModel();
  assert(typeof initialModel === 'string' && initialModel.length > 0);

  updateSettings({ gemini_model: 'gemini-custom-selected' });
  const updatedModel = getGeminiModel();
  assert.strictEqual(updatedModel, 'gemini-custom-selected', 'getGeminiModel should return updated setting');
  pass('updateSettings and getGeminiModel handle custom model configuration');

  // Reset back to a sensible model
  updateSettings({ gemini_model: 'gemini-2.0-flash' });

  // --- 3. Dynamic Prompt Injection (Profiles & Lists) ---
  console.log('\n--- 3. Dynamic Prompt Context Injection ---');
  const testFamilyName = 'TestMember_' + Date.now();
  const createdProfile = insertProfile({
    name: testFamilyName,
    avatar: '👩',
    color: '#ec4899',
    language: 'en'
  });

  const testFeedName = 'School Calendar ' + Date.now();
  const createdFeed = insertCalendarFeed({
    name: testFeedName,
    ical_url: 'https://example.com/calendar.ics',
    color: '#8b5cf6',
    profile_id: createdProfile.id
  });

  const promptText = buildSystemPrompt('text', 'TestSender');
  assert(promptText.includes(testFamilyName), 'Prompt must include registered family member');
  assert(promptText.includes('Shopping List') || promptText.includes('Family Tasks'), 'Prompt must list dashboard lists');
  assert(promptText.includes(testFeedName), 'Prompt must include available calendar feed');
  pass('buildSystemPrompt dynamically injects registered profiles, lists, and calendar feeds');

  deleteCalendarFeed(createdFeed.id);

  // --- 4. Normalization of Family vs Individual & Recurrence ---
  console.log('\n--- 4. Payload Normalization ---');
  const pianoTitle = 'Piano lesson ' + testFamilyName;
  const famMovieTitle = 'Family Movie Night ' + testFamilyName;

  const rawPayload = {
    tasks: [
      { title: 'Take out bins', assignee: testFamilyName, recurrence: 'weekly', recurrence_interval: 1 },
      { title: 'Clean hallway', assignee: 'everyone', recurrence: 'daily' },
      { title: 'Family chore', assignee: 'whole family' }
    ],
    shopping_items: [
      { content: 'Organic Milk', assignee: testFamilyName, list_name: 'Organic Groceries', recurrence: 'weekly' },
      { content: 'Apples', assignee: 'family' }
    ],
    calendar_events: [
      { title: pianoTitle, date: '2026-10-20', time: '16:00', person: testFamilyName, recurrence: 'weekly' },
      { title: famMovieTitle, date: '2026-10-24', time: '20:00', person: 'entire family' }
    ]
  };

  const normalized = normalizeParsedGeminiPayload(rawPayload);
  assert.strictEqual(normalized.tasks[0].assignee, testFamilyName);
  assert.strictEqual(normalized.tasks[0].recurrence, 'weekly');
  assert.strictEqual(normalized.tasks[1].assignee, null, "'everyone' mapped to null (family task)");
  assert.strictEqual(normalized.tasks[2].assignee, null, "'whole family' mapped to null");

  assert.strictEqual(normalized.shopping_items[0].assignee, testFamilyName);
  assert.strictEqual(normalized.shopping_items[0].list_name, 'Organic Groceries');
  assert.strictEqual(normalized.shopping_items[1].assignee, null, "'family' mapped to null");

  assert.strictEqual(normalized.calendar_events[0].person, testFamilyName);
  assert.strictEqual(normalized.calendar_events[0].recurrence, 'weekly');
  assert.strictEqual(normalized.calendar_events[1].person, null, "'entire family' mapped to null");
  pass('normalizeParsedGeminiPayload properly mapped family keywords to null and preserved recurrence');

  // --- 5. Action Execution (Tasks, Groceries, Calendar) ---
  console.log('\n--- 5. Action Execution for Individuals, Family & Recurrence ---');
  const mockIo = { emit: () => {} };
  const actionResult = await applyParsedGeminiActions(normalized, createdProfile, mockIo);

  // 5a. Tasks verification
  const tasksList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
  const currentTaskItems = getListById(tasksList.id).items;

  // Individual task
  const indTask = currentTaskItems.find(t => t.content === 'Take out bins');
  assert(indTask, 'Individual task must exist');
  assert.strictEqual(indTask.assignee_profile_id, createdProfile.id, 'Task assigned to specific profile ID');
  assert.strictEqual(indTask.recurrence, 'weekly', 'Recurrence preserved on task');

  // Family task
  const famTask = currentTaskItems.find(t => t.content === 'Clean hallway');
  assert(famTask, 'Family task must exist');
  assert.strictEqual(famTask.assignee_profile_id, null, 'Family task has null assignee_profile_id');

  const legacyFamTask = getTasks().find(t => t.title === 'Clean hallway');
  assert(legacyFamTask, 'Family task exists in legacy tasks table');
  assert.strictEqual(legacyFamTask.assignee, 'Family');
  pass('Tasks created accurately for both specific person and entire family');

  // 5b. Shopping items verification
  // Custom named list
  const customList = getLists().find(l => l.name === 'Organic Groceries');
  assert(customList, 'Custom named shopping list must be created');
  const customItems = getListById(customList.id).items;
  const organicMilk = customItems.find(i => i.content === 'Organic Milk');
  assert(organicMilk, 'Organic Milk created under custom list');
  assert.strictEqual(organicMilk.assignee_profile_id, createdProfile.id);
  assert.strictEqual(organicMilk.recurrence, 'weekly');

  // Family shopping item in default list
  const mainShopList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
  const mainShopItems = getListById(mainShopList.id).items;
  const applesItem = mainShopItems.find(i => i.content === 'Apples');
  assert(applesItem, 'Apples created in default shopping list');
  assert.strictEqual(applesItem.assignee_profile_id, null, 'Family shopping item has null assignee');
  pass('Shopping items created accurately with custom lists, person, and family assignment');

  // 5c. Calendar events verification
  const allEvents = getCalendarEvents({ limit: 500 });
  const indEvents = allEvents.filter(e => e.title === pianoTitle);
  assert(indEvents.length >= 2, 'Recurring piano lesson generated multiple future instances');
  assert.strictEqual(indEvents[0].profile_id, createdProfile.id, 'Individual event assigned to profile ID');

  const famEvents = allEvents.filter(e => e.title === famMovieTitle);
  assert(famEvents.length >= 1, 'Family movie night created');
  assert.strictEqual(famEvents[0].profile_id, null, 'Family event has null profile_id');
  pass('Calendar events created accurately for specific person and entire family with recurrence');

  // --- 6. Admin API Endpoint for Models ---
  console.log('\n--- 6. REST API Models Endpoint ---');
  const { server } = require('../src/server');
  const PORT = 3998;
  await new Promise(resolve => server.listen(PORT, resolve));

  const adminPass = process.env.ADMIN_PASS || 'your_admin_pass';
  const basicAuthHeader = 'Basic ' + Buffer.from('admin:' + adminPass).toString('base64');

  const res = await fetchJson(`http://localhost:${PORT}/api/admin/gemini/models`, {
    headers: { 'Authorization': basicAuthHeader }
  });
  assert.strictEqual(res.status, 200);
  assert(Array.isArray(res.data.models), 'Response models must be an array');
  assert(res.data.models.length > 0);
  pass('GET /api/admin/gemini/models returned 200 with models array');

  server.close();
  console.log('\n=== ALL GEMINI MODELS & FAMILY ACTIONS TESTS PASSED! ===');
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
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data });
        }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

runTests().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
