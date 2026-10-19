const http = require('http');
const fs = require('fs');
const path = require('path');
const { io: Client } = require('socket.io-client');

// Set isolated test DB before requiring app modules
const testDbPath = path.join(__dirname, '../data/test-phase2-enhancements.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${testDbPath}${suffix}`;
  if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
}
process.env.DB_PATH = testDbPath;
process.env.ADMIN_PASS = 'test_admin_secret';

const dbModule = require('../src/db');
const { createMaintenanceService } = require('../src/services/maintenance');
const { app, server } = require('../src/server');

async function runPhase2EnhancementsTests() {
  const testPort = 3988;
  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Phase 2 Enhancements Test Server listening on port ${testPort}`);

  let failures = 0;
  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failures++;
    }
  }

  function makeRequest(reqPath, method = 'GET', body = null, useAuth = true) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (useAuth) {
        headers.authorization = 'Basic ' + Buffer.from('admin:test_admin_secret').toString('base64');
      }
      let payload = null;
      if (body !== null) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: testPort,
          path: reqPath,
          method,
          headers
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(raw);
            } catch (_) {}
            resolve({ statusCode: res.statusCode, raw, json });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  try {
    console.log('\n=== 1. AES-256-GCM Encryption at Rest for librus_password ===');
    const profRes = await makeRequest('/api/admin/profiles', 'POST', {
      name: 'Leo Student',
      color: '#38bdf8',
      avatar_type: 'builtin',
      avatar_value: '🦁',
      telegram_id: '777888999',
      librus_login: 'leo_librus_user',
      librus_password: 'SuperSecretLibrusPassword!2026'
    });
    assert(profRes.statusCode === 200 && profRes.json && profRes.json.ok, 'Created profile with Librus credentials');
    const leoId = profRes.json.profile.id;

    const rawRow = dbModule.getRawProfileById(leoId);
    assert(
      rawRow && typeof rawRow.librus_password === 'string' && rawRow.librus_password.startsWith('enc:v1:'),
      `Raw SQLite librus_password column is AES-256-GCM encrypted (${rawRow && rawRow.librus_password.slice(0, 18)}...)`
    );
    assert(
      rawRow.librus_password !== 'SuperSecretLibrusPassword!2026',
      'Raw SQLite column does not store plaintext password'
    );

    const decryptedRow = dbModule.getProfileById(leoId);
    assert(
      decryptedRow && decryptedRow.librus_password === 'SuperSecretLibrusPassword!2026',
      'getProfileById transparently decrypts librus_password for service consumption'
    );

    console.log('\n=== 2. Smart Ingredient Quantity Merging & Store Aisle Categorization ===');
    assert(dbModule.inferShoppingCategory('2 Eggs') === 'Dairy', 'Infers Dairy category for "2 Eggs"');
    assert(dbModule.inferShoppingCategory('Fresh Apples') === 'Produce', 'Infers Produce category for "Fresh Apples"');
    assert(dbModule.inferShoppingCategory('Sourdough Bread') === 'Bakery', 'Infers Bakery category for "Sourdough Bread"');
    assert(dbModule.inferShoppingCategory('500g Flour') === 'Pantry', 'Infers Pantry category for "500g Flour"');

    const lists = dbModule.getLists();
    const shoppingList = lists.find((l) => l.type === 'shopping');
    assert(Boolean(shoppingList), 'Default shopping list exists');

    // Clear existing items in shopping list for clean test
    for (const item of shoppingList.items) {
      dbModule.deleteListItem(item.id);
    }

    dbModule.insertListItem({ list_id: shoppingList.id, content: '2 Eggs' });
    const mergedEgg = dbModule.insertListItem({ list_id: shoppingList.id, content: '3 Eggs' });
    assert(mergedEgg && mergedEgg.merged === true, 'Adding "3 Eggs" to existing "2 Eggs" merges items');
    assert(mergedEgg.content === '5 Eggs', `Merged quantity content is "5 Eggs" (got "${mergedEgg.content}")`);
    assert(mergedEgg.category === 'Dairy', `Merged item category is "Dairy" (got "${mergedEgg.category}")`);

    dbModule.insertListItem({ list_id: shoppingList.id, content: '200g Flour' });
    const mergedFlour = dbModule.insertListItem({ list_id: shoppingList.id, content: '300g Flour' });
    assert(mergedFlour && mergedFlour.merged === true, 'Adding "300g Flour" to "200g Flour" merges items');
    assert(mergedFlour.content === '500g Flour', `Merged metric weight is "500g Flour" (got "${mergedFlour.content}")`);

    console.log('\n=== 3. Kids Chore Reward Store & Automatic Points Ledger ===');
    const tasksList = lists.find((l) => l.type === 'tasks');
    const choreItem = dbModule.insertListItem({
      list_id: tasksList.id,
      content: 'Clean bedroom & desk',
      assignee_profile_id: leoId,
      reward: 40
    });
    assert(choreItem && choreItem.id, 'Created chore assigned to Leo with 40 reward points');

    dbModule.toggleListItemChecked(choreItem.id, true, 'Leo Student');
    let leoAfterChore = dbModule.getProfileById(leoId);
    assert(
      Number(leoAfterChore.points_balance) === 40,
      `Completing chore credits +40 points to Leo (balance=${leoAfterChore.points_balance})`
    );

    // Unchecking should revert points
    dbModule.toggleListItemChecked(choreItem.id, false, null);
    leoAfterChore = dbModule.getProfileById(leoId);
    assert(
      Number(leoAfterChore.points_balance) === 0,
      `Unchecking chore deducts 40 points from Leo (balance=${leoAfterChore.points_balance})`
    );

    // Re-check chore so Leo has 40 points
    dbModule.toggleListItemChecked(choreItem.id, true, 'Leo Student');
    leoAfterChore = dbModule.getProfileById(leoId);
    assert(Number(leoAfterChore.points_balance) === 40, 'Re-checking chore restores 40 points');

    // Create a custom reward via Admin API
    const createRewardRes = await makeRequest('/api/admin/rewards', 'POST', {
      title: 'Lego Minifigure Pack',
      cost: 25,
      icon: '🧱'
    });
    assert(
      createRewardRes.statusCode === 200 && createRewardRes.json && createRewardRes.json.reward,
      'POST /api/admin/rewards creates new reward'
    );
    const rewardId = createRewardRes.json.reward.id;

    // Redeem reward via Kiosk endpoint
    const redeemRes = await makeRequest(
      '/api/rewards/redeem',
      'POST',
      { profile_id: leoId, reward_id: rewardId },
      false
    );
    assert(redeemRes.statusCode === 200 && redeemRes.json && redeemRes.json.ok, 'POST /api/rewards/redeem succeeds');
    assert(
      redeemRes.json.redemption.remaining_points === 15,
      `Remaining points after 25pt redemption is 15 (got ${redeemRes.json.redemption.remaining_points})`
    );

    // Attempt to redeem again with insufficient points (15 < 25)
    const redeemFailRes = await makeRequest(
      '/api/rewards/redeem',
      'POST',
      { profile_id: leoId, reward_id: rewardId },
      false
    );
    assert(redeemFailRes.statusCode === 400, 'Redeeming without enough points returns HTTP 400');

    console.log('\n=== 4. Scoped Socket.IO Delta Broadcasts ===');
    const socket = Client(`http://127.0.0.1:${testPort}`, {
      transports: ['websocket'],
      auth: { token: process.env.DASHBOARD_TOKEN || 'your_secret_token' }
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });

    const deltaPromise = new Promise((resolve) => {
      socket.once('dashboard:delta', (payload) => resolve(payload));
    });

    socket.emit('list:item:add', {
      list_id: shoppingList.id,
      content: 'Fresh Strawberries'
    });

    const deltaPayload = await deltaPromise;
    assert(
      deltaPayload && deltaPayload.section === 'lists' && Array.isArray(deltaPayload.lists),
      `Socket.IO emits scoped dashboard:delta with section="lists" (received section="${deltaPayload && deltaPayload.section}")`
    );
    socket.disconnect();

    console.log('\n=== 5. Touch Kiosk Numeric PIN & Auth Rate Limiter ===');
    const pinSaveRes = await makeRequest('/api/admin/settings', 'POST', {
      kiosk_pin: '4826'
    });
    assert(pinSaveRes.statusCode === 200 && pinSaveRes.json.settings.kiosk_pin === '4826', 'Saved kiosk_pin="4826"');

    const verifyPinRes = await makeRequest('/api/verify-pass', 'POST', { password: '4826' }, false);
    assert(
      verifyPinRes.statusCode === 200 && verifyPinRes.json && verifyPinRes.json.valid === true,
      'POST /api/verify-pass accepts configured Kiosk Numeric PIN'
    );

    const verifyAdminPassRes = await makeRequest('/api/verify-pass', 'POST', { password: 'test_admin_secret' }, false);
    assert(
      verifyAdminPassRes.statusCode === 200 && verifyAdminPassRes.json && verifyAdminPassRes.json.valid === true,
      'POST /api/verify-pass still accepts full ADMIN_PASS'
    );

    // Trigger 12 failed attempts and verify 13th is rate-limited with HTTP 429
    if (app.locals && typeof app.locals.resetAuthRateLimiter === 'function') {
      app.locals.resetAuthRateLimiter();
    }
    for (let i = 0; i < 12; i++) {
      await makeRequest('/api/verify-pass', 'POST', { password: 'wrong_pin' }, false);
    }
    const rateLimitedRes = await makeRequest('/api/verify-pass', 'POST', { password: 'wrong_pin' }, false);
    assert(
      rateLimitedRes.statusCode === 429,
      `13th failed auth attempt is blocked with HTTP 429 Too Many Requests (got ${rateLimitedRes.statusCode})`
    );
    if (app.locals && typeof app.locals.resetAuthRateLimiter === 'function') {
      app.locals.resetAuthRateLimiter();
    }

    console.log('\n=== 6. Proactive Evening Summary Subscription ===');
    const eveningNow = new Date(2026, 9, 19, 19, 30, 0); // Monday Oct 19, 2026 19:30 -> Tomorrow is Tuesday
    dbModule.insertSchedule({
      name: 'Leo School Plan',
      profile_id: leoId,
      schedule: [
        {
          day: 'Tuesday',
          lessons: [{ number: 1, start: '08:00', end: '08:45', name: 'Mathematics', room: '101' }]
        }
      ]
    });

    const activeMenu = dbModule.getActiveMealMenu();
    if (activeMenu) {
      dbModule.setMealSlotEntry(activeMenu.id, 'Tuesday', 'Dinner', {
        dish_id: null,
        custom_text: 'Homemade Lasagna'
      });
    }

    dbModule.upsertScheduledSubscription({
      profile_id: leoId,
      type: 'evening_summary',
      enabled: true,
      send_time: '19:30'
    });

    let sentEveningMessage = null;
    const maintenance = createMaintenanceService({
      db: dbModule.db,
      bot: {
        telegram: {
          sendMessage: async (chatId, text) => {
            sentEveningMessage = { chatId: String(chatId), text };
          }
        }
      },
      getSettings: dbModule.getSettings,
      updateSettings: dbModule.updateSettings,
      pruneData: dbModule.pruneData,
      getSubscriptions: dbModule.getScheduledSubscriptions,
      markSubscriptionSent: dbModule.markScheduledSubscriptionSent,
      getLists: dbModule.getLists,
      getSchedules: dbModule.getSchedules,
      getLibrusData: dbModule.getLibrusData,
      getActiveMealMenu: dbModule.getActiveMealMenu,
      getDishes: dbModule.getDishes,
      clock: () => eveningNow
    });

    await maintenance.runOnce(eveningNow);

    assert(
      sentEveningMessage && sentEveningMessage.chatId === '777888999',
      'Evening summary subscription delivered to Leo Telegram chat ID'
    );
    assert(
      sentEveningMessage &&
        sentEveningMessage.text.includes('Mathematics') &&
        sentEveningMessage.text.includes('Homemade Lasagna'),
      'Evening summary includes tomorrow classes ("Mathematics") and tomorrow planned meal ("Homemade Lasagna")'
    );

    console.log('\n=== 7. Offline Service Worker & Modular Frontend Assets ===');
    const swRes = await makeRequest('/sw.js', 'GET', null, false);
    assert(swRes.statusCode === 200 && swRes.raw.includes('CACHE_NAME'), 'GET /sw.js serves Service Worker script');

    const kioskJsRes = await makeRequest('/js/kiosk-enhancements.js', 'GET', null, false);
    assert(
      kioskJsRes.statusCode === 200 && kioskJsRes.raw.includes('KioskEnhancements'),
      'GET /js/kiosk-enhancements.js serves modular Kiosk utilities'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${testDbPath}${suffix}`;
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
    }
  }

  if (failures > 0) {
    console.error(`\n❌ Phase 2 Enhancements Tests failed with ${failures} failure(s).`);
    process.exit(1);
  } else {
    console.log('\n🎉 All Phase 2 Enhancements Tests passed!');
    process.exit(0);
  }
}

runPhase2EnhancementsTests().catch((err) => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
