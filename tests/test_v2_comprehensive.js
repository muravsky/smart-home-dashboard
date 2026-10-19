const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { io: Client } = require('socket.io-client');

const testDbPath = path.join(__dirname, '../data/test-v2-comprehensive.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${testDbPath}${suffix}`;
  if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
}
process.env.DB_PATH = testDbPath;
process.env.DASHBOARD_TOKEN = 'your_secret_token';
process.env.ADMIN_PASS = 'your_admin_pass';

const db = require('../src/db');
const { normalizeTimetableData, resolveLessonsForDate } = require('../src/services/librus');
const { buildSystemPrompt, normalizeParsedGeminiPayload } = require('../src/services/gemini');
const { applyParsedGeminiActions } = require('../src/bot');
const { server } = require('../src/server');

function pass(msg) {
  console.log(`[PASS] ${msg}`);
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
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runTests() {
  console.log('=== STARTING V2 COMPREHENSIVE FEATURE TESTS ===');

  // --- 1. Screensaver & Night Mode ---
  console.log('\n--- 1. Screensaver & Night Mode ---');
  db.updateSettings({ night_mode_enabled: false });
  assert.strictEqual(Boolean(db.getSettings().night_mode_enabled), false, 'boolean false should save as falsy (0)');
  db.updateSettings({ night_mode_enabled: '0' });
  assert.strictEqual(Boolean(db.getSettings().night_mode_enabled), false, 'string "0" should save as falsy (0)');
  db.updateSettings({ night_mode_enabled: 1 });
  assert.strictEqual(Boolean(db.getSettings().night_mode_enabled), true, 'number 1 should save as truthy (1)');
  pass('night_mode_enabled settings coercion works for booleans, numbers, and strings');

  const publicHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert(publicHtml.includes('html.theme-white .screensaver-overlay') && publicHtml.includes('background-color: #000000 !important'), 'screensaver overlay enforces dark background in white theme');
  assert(publicHtml.includes('displayedScreensaverPhoto,'), 'displayedScreensaverPhoto is exported from setup()');
  assert(publicHtml.includes('if (isNightModeActive.value)'), 'activeTheme switches to dark when Night Mode is active');
  pass('Public Kiosk HTML includes screensaver & night mode fixes');

  // --- 2. Timetable Sunday / Next-Week Resolution ---
  console.log('\n--- 2. Timetable Sunday / Next-Week Resolution ---');
  const dualWeekRaw = {
    referenceDate: '2026-10-18T12:00:00Z', // Sunday Oct 18, 2026
    currentWeek: {
      hours: ['08:00-08:45', '09:00-09:45'],
      table: {
        Monday: [
          { subject: 'Math', time: '08:00-08:45', cancelled: true, flag: 'odwołane' },
          { subject: 'History (Sub)', time: '09:00-09:45', flag: 'zastępstwo', original: { subject: 'Biology' } }
        ]
      }
    },
    nextWeek: {
      hours: ['08:00-08:45', '09:00-09:45'],
      table: {
        Monday: [
          { subject: 'Math', time: '08:00-08:45' },
          { subject: 'Biology', time: '09:00-09:45' }
        ]
      }
    }
  };

  const normalizedDual = normalizeTimetableData(dualWeekRaw, { referenceDate: new Date('2026-10-18T12:00:00Z') });
  const mondayRow = normalizedDual.find(d => d.day === 'Monday');
  assert(mondayRow, 'Monday row normalized');
  assert.strictEqual(mondayRow.date, '2026-10-12', 'Current week Monday date is 2026-10-12');
  assert.strictEqual(mondayRow.nextDate, '2026-10-19', 'Next week Monday date is 2026-10-19');
  assert.strictEqual(mondayRow.lessons[0].cancelled, true, 'Current week Monday retains cancelled flag');
  assert.strictEqual(mondayRow.nextLessons[0].cancelled, false, 'Next week Monday has clean lessons without past week cancellation');
  assert.strictEqual(mondayRow.nextLessons[1].name, 'Biology', 'Next week Monday has regular Biology instead of past week substitution');

  const resolvedNextMonday = resolveLessonsForDate(mondayRow, '2026-10-19');
  assert.strictEqual(resolvedNextMonday[0].cancelled, false, 'resolveLessonsForDate for 2026-10-19 returns next week clean Math');
  assert.strictEqual(resolvedNextMonday[1].name, 'Biology', 'resolveLessonsForDate for 2026-10-19 returns next week Biology');

  // Verify DB schedule normalization preserves date, nextDate, nextLessons
  const savedSched = db.insertSchedule({ name: 'Dual Week Test', schedule: normalizedDual });
  assert.strictEqual(savedSched.schedule[0].date, '2026-10-12', 'DB preserves day.date');
  assert.strictEqual(savedSched.schedule[0].nextDate, '2026-10-19', 'DB preserves day.nextDate');
  assert(Array.isArray(savedSched.schedule[0].nextLessons) && savedSched.schedule[0].nextLessons.length === 2, 'DB preserves day.nextLessons');
  pass('Timetable dual-week normalization, Sunday next-Monday resolution, and DB persistence verified');

  // --- 3. Shopping List Deduplication, Reactivation & Resolved History ---
  console.log('\n--- 3. Shopping List Deduplication & Resolved History ---');
  const shoppingList = db.insertList({ name: 'Family Shopping', type: 'shopping', icon: '🛒' });
  const item1 = db.insertListItem({ list_id: shoppingList.id, content: 'Organic Milk' });
  const item1Dup = db.insertListItem({ list_id: shoppingList.id, content: '  organic milk  ' });
  assert.strictEqual(item1.id, item1Dup.id, 'Duplicate unchecked shopping item should not create a duplicate row');

  const checkedMilk = db.toggleListItemChecked(item1.id, true, 'Alice');
  assert.strictEqual(checkedMilk.checked, 1, 'Item marked checked');
  assert.strictEqual(checkedMilk.completed_by, 'Alice', 'completed_by recorded as Alice');
  assert(checkedMilk.completed_at || checkedMilk.last_completed_at, 'completed_at timestamp recorded');

  const resolvedItems = db.getListById(shoppingList.id).items.filter(i => i.checked || i.last_completed_at);
  assert(resolvedItems.some(i => i.id === item1.id && i.completed_by === 'Alice'), 'list items track item completed today with completed_by');

  // Re-adding a checked shopping item should reactivate it instead of duplicating
  const reactivatedMilk = db.insertListItem({ list_id: shoppingList.id, content: 'Organic Milk' });
  assert.strictEqual(reactivatedMilk.id, item1.id, 'Re-adding checked shopping item reactivates existing row');
  assert.strictEqual(reactivatedMilk.checked, 0, 'Reactivated item has checked=0');

  // Clear completed items
  db.toggleListItemChecked(item1.id, true, 'Bob');
  db.clearCompletedListItems(shoppingList.id);
  const remainingShop = db.getListById(shoppingList.id).items;
  assert.strictEqual(remainingShop.length, 0, 'clearCompletedListItems removes checked items');
  pass('Shopping list deduplication, reactivation, completed_by tracking, and clearCompletedListItems verified');

  // --- 4. Menu of the Week & Dish Catalog (DB + Push Ingredients) ---
  console.log('\n--- 4. Menu of the Week & Dish Catalog ---');
  const allDishes = db.getDishes();
  assert(allDishes.length >= 4, 'Default dishes seeded in DB');

  const customDish = db.insertDish({
    name: 'Homemade Lasagna',
    ingredients: ['Lasagna sheets', 'Minced beef', 'Mozzarella'],
    recipe: 'Layer pasta, meat sauce, and cheese. Bake 40 min at 190C.',
    tags: ['dinner', 'italian']
  });
  assert.strictEqual(customDish.name, 'Homemade Lasagna');
  assert.strictEqual(customDish.ingredients.length, 3);

  const updatedDish = db.updateDish(customDish.id, { name: 'Classic Beef Lasagna' });
  assert.strictEqual(updatedDish.name, 'Classic Beef Lasagna');

  const menus = db.getMealMenus();
  assert(menus.length >= 1, 'Default weekly meal menu seeded');
  const activeMenu = menus[0];

  const updatedMenu = db.setMealSlotEntry({
    menu_id: activeMenu.id,
    day: 'Monday',
    slot: 'Dinner',
    entries: [{ dish_id: customDish.id, custom_title: '' }]
  });
  assert.strictEqual(updatedMenu.schedule.Monday.Dinner[0].dish_id, customDish.id, 'Monday Dinner slot assigned to custom dish');
  pass('Dish catalog CRUD and weekly meal menu slot assignment verified');

  // --- 5. Gemini System Prompt & AI CRUD / Meal Actions ---
  console.log('\n--- 5. Gemini System Prompt & AI CRUD / Meal Actions ---');
  const customPackingList = db.insertList({ name: 'Camping Trip', type: 'custom', icon: '⛺' });
  const promptText = buildSystemPrompt();
  assert(promptText.includes('Camping Trip'), 'Gemini system prompt includes custom lists');
  assert(promptText.includes('Classic Beef Lasagna'), 'Gemini system prompt includes dish catalog');
  assert(promptText.includes('meal_actions'), 'Gemini system prompt documents meal_actions');

  const normalizedGemini = normalizeParsedGeminiPayload({
    notes: [{ action: 'add', content: 'Initial note' }],
    shopping_items: [{ action: 'add', content: 'Sleeping bag', list_name: 'Camping Trip' }],
    meal_actions: [{ action: 'set_slot', day: 'Wednesday', slot: 'Dinner', dish_name: 'Classic Beef Lasagna' }]
  });
  assert.strictEqual(normalizedGemini.meal_actions.length, 1);

  const aiRes = await applyParsedGeminiActions(normalizedGemini, { id: null, name: 'Parent' }, null);
  assert(aiRes.summary.includes('Added 1 note(s)'));
  assert(aiRes.summary.includes('Added 1 shopping item(s)'));
  assert(aiRes.summary.includes('Processed 1 meal action(s)'));

  const campingItems = db.getListById(customPackingList.id).items;
  assert(campingItems.some(i => i.content === 'Sleeping bag'), 'Gemini added item to custom list "Camping Trip"');
  const wedDinner = db.getMealMenuById(activeMenu.id).schedule.Wednesday.Dinner;
  assert.strictEqual(wedDinner[0].dish_id, customDish.id, 'Gemini set Wednesday Dinner to Classic Beef Lasagna');
  pass('Gemini custom list routing and meal planner actions verified');

  // --- 6. REST API & Socket.IO Full CRUD + HTTPS Status ---
  console.log('\n--- 6. REST API & Socket.IO Full CRUD + HTTPS Status ---');
  const PORT = 3997;
  await new Promise(resolve => server.listen(PORT, resolve));
  const basicAuth = 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64');
  const authHeaders = { 'Authorization': basicAuth, 'Content-Type': 'application/json' };

  // 6a. HTTPS Status endpoint
  const httpsStatus = await fetchJson(`http://localhost:${PORT}/api/admin/https/status`, { headers: authHeaders });
  assert.strictEqual(httpsStatus.status, 200);
  assert(typeof httpsStatus.data.key_exists === 'boolean', 'HTTPS status reports key_exists');
  assert(fs.existsSync(path.join(__dirname, '../scripts/setup_https.sh')), 'scripts/setup_https.sh exists');
  pass('HTTPS status API and setup_https.sh verified');

  // 6b. Note update endpoint
  const createdNote = db.insertNote('Draft note');
  const noteEditRes = await fetchJson(`http://localhost:${PORT}/api/admin/notes/${createdNote.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ content: 'Edited note content' })
  });
  assert.strictEqual(noteEditRes.status, 200);
  assert.strictEqual(noteEditRes.data.note.content, 'Edited note content');
  pass('PATCH /api/admin/notes/:id edits note content');

  // 6c. Calendar event update endpoint
  const calEv = db.insertCalendarEvent({
    title: 'Original Event',
    start_datetime: '2026-11-01T10:00:00'
  });
  const calEditRes = await fetchJson(`http://localhost:${PORT}/api/admin/calendar/events/${calEv.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ title: 'Updated Event Title' })
  });
  assert.strictEqual(calEditRes.status, 200);
  assert.strictEqual(calEditRes.data.event.title, 'Updated Event Title');
  pass('PATCH /api/admin/calendar/events/:id edits calendar event');

  // 6d. Dishes & Meal Menus REST endpoints + Push Ingredients to Shopping List
  const dishesRes = await fetchJson(`http://localhost:${PORT}/api/admin/dishes`, { headers: authHeaders });
  assert.strictEqual(dishesRes.status, 200);
  assert(Array.isArray(dishesRes.data));

  const mealMenusRes = await fetchJson(`http://localhost:${PORT}/api/admin/meal-menus`, { headers: authHeaders });
  assert.strictEqual(mealMenusRes.status, 200);
  assert(Array.isArray(mealMenusRes.data));

  const pushShopRes = await fetchJson(`http://localhost:${PORT}/api/admin/meal-menus/add-to-shopping`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ dish_id: customDish.id })
  });
  assert.strictEqual(pushShopRes.status, 200);
  assert.strictEqual(pushShopRes.data.count, 3, 'Pushed dish ingredients to shopping list via REST API');
  pass('Dishes, Meal Menus, and Add-to-Shopping REST endpoints verified');

  // 6e. Socket.IO interactive CRUD & Meal events
  const socket = Client(`http://localhost:${PORT}`, {
    auth: { token: 'your_secret_token' }
  });
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });

  const testItem = db.insertListItem({ list_id: customPackingList.id, content: 'Flashlight' });
  await new Promise((resolve) => {
    socket.once('dashboard_update', (payload) => {
      const updatedList = payload.lists.find(l => l.id === customPackingList.id);
      const updatedItem = updatedList.items.find(i => i.id === testItem.id);
      if (updatedItem && updatedItem.content === 'LED Headlamp') resolve();
    });
    socket.emit('list:item:update', { id: testItem.id, content: 'LED Headlamp' });
  });
  pass('Socket.IO list:item:update updated item in real time');

  socket.disconnect();
  server.close();

  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${testDbPath}${suffix}`;
    if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
  }

  console.log('\n=== ALL V2 COMPREHENSIVE TESTS PASSED SUCCESSFULLY ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
