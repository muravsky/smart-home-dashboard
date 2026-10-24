/**
 * Unit & Integration Tests for Telegram List Viewing, Safe Markdown & Query Intents
 */
const path = require('path');
const fs = require('fs');

const testDbPath = path.join(__dirname, 'test_telegram_list_fixes.db');
process.env.DB_PATH = testDbPath;
for (const suffix of ['', '-wal', '-shm']) {
  const p = `${testDbPath}${suffix}`;
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

const {
  db,
  insertList,
  insertListItem,
  getLists,
  insertProfile
} = require('../src/db');

const {
  detectListQueryIntent,
  buildListKeyboardAndText,
  buildConfirmationMessage,
  escapeMd,
  safeReplyMarkdown,
  safeEditMarkdown,
  getOrCreateDashboardList
} = require('../src/bot');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`❌ FAIL: ${message}`);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTests() {
  console.log('=== 1. Natural Language List Query Intent Detection ===');

  const shoppingQueries = [
    'shopping',
    'shopping list',
    'show shopping',
    'show shopping list',
    'view shopping',
    'list shopping',
    'what is on the shopping list',
    'what\'s on my shopping list?',
    'groceries',
    'open groceries',
    'список покупок',
    'покажи покупки',
    'что в списке покупок?'
  ];
  for (const q of shoppingQueries) {
    const res = detectListQueryIntent(q);
    assert(res && res.type === 'shopping', `Detected shopping intent for query: "${q}"`);
  }

  const taskQueries = [
    'tasks',
    'show tasks',
    'list tasks',
    'what are my tasks',
    'chores',
    'to-dos',
    'задачи',
    'список задач',
    'покажи список задач'
  ];
  for (const q of taskQueries) {
    const res = detectListQueryIntent(q);
    assert(res && res.type === 'tasks', `Detected tasks intent for query: "${q}"`);
  }

  const allListsQueries = ['lists', 'all lists', 'show lists', 'списки', 'все списки'];
  for (const q of allListsQueries) {
    const res = detectListQueryIntent(q);
    assert(res && res.type === 'all', `Detected all lists intent for query: "${q}"`);
  }

  const namedListQueries = ['show Packing list', 'open Camping Gear list', 'view Hardware Store'];
  for (const q of namedListQueries) {
    const res = detectListQueryIntent(q);
    assert(res && res.type === 'named', `Detected named list intent for query: "${q}"`);
  }

  assert(detectListQueryIntent('hello how are you') === null, 'Non-list query returns null');
  assert(detectListQueryIntent('/shopping') === null, 'Slash command is ignored by detectListQueryIntent');

  console.log('\n=== 2. Multi-List Prioritization & Keyboard Generation ===');

  // 1. Verify getOrCreateDashboardList picks the active Shopping List with items from DB
  const defaultShop = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
  assert(defaultShop && defaultShop.items.length > 0, 'getOrCreateDashboardList picked active shopping list with items');

  // 2. Test duplicate name prioritization: an empty list vs a populated list
  const emptyList = insertList({ name: 'Camping Trip', type: 'packing', icon: '⛺' });
  const filledList = insertList({ name: 'Camping Trip', type: 'packing', icon: '⛺' });
  insertListItem({ list_id: filledList.id, content: 'Tent & Stakes' });
  insertListItem({ list_id: filledList.id, content: 'Sleeping Bags' });

  const pickedCustom = getOrCreateDashboardList('packing', 'Camping Trip', '⛺');
  assert(pickedCustom.id === filledList.id, 'getOrCreateDashboardList prioritized duplicate list that has active items over empty list');

  // 3. Test keyboard generation with dynamic escaping & sibling lists
  const organicShop = insertList({ name: 'Organic Market', type: 'shopping', icon: '🌿' });
  insertListItem({ list_id: organicShop.id, content: 'Organic Eggs', category: 'Dairy' });

  const testShop = insertList({ name: 'Quick Market', type: 'shopping', icon: '🛒' });
  insertListItem({ list_id: testShop.id, content: 'Milk_1L (Whole)', category: 'Dairy' });
  insertListItem({ list_id: testShop.id, content: 'Apples [Honeycrisp]', category: 'Produce' });

  const { text, keyboard } = buildListKeyboardAndText(testShop.id, false);
  assert(text.includes('🛒 *Quick Market*'), 'List header formatted with emoji and title');
  assert(text.includes('Milk\\_1L'), 'Underscores in item contents are escaped against Markdown crashes');
  assert(!text.includes('~'), 'No invalid tilde markdown strikethrough');
  assert(text.includes('• 🏷️ Dairy') || text.includes('• 🏷️ Produce'), 'Categories displayed as bullet badges');
  assert(
    keyboard && keyboard.reply_markup && keyboard.reply_markup.inline_keyboard.length > 0,
    'Inline keyboard buttons generated'
  );

  // Check sibling list switcher button
  const allButtonsFlat = keyboard.reply_markup.inline_keyboard.flat();
  const siblingBtn = allButtonsFlat.find(b => b.text.includes('Organic Market'));
  assert(Boolean(siblingBtn), 'Sibling shopping list switcher button generated');

  // Verify NO delete button is present in keyboard
  const deleteBtn = allButtonsFlat.find(b => b.text.includes('🗑️') || (b.callback_data && b.callback_data.startsWith('item:del:')));
  assert(!deleteBtn, 'No delete (🗑️) button present in keyboard');

  // 4. Test displaying all items (>15 items) and lack of delete buttons
  const longList = insertList({ name: 'Huge Grocery Haul', type: 'shopping', icon: '🛒' });
  for (let i = 1; i <= 22; i++) {
    insertListItem({ list_id: longList.id, content: `Grocery_item_${i}` });
  }

  const { text: longText, keyboard: longKeyboard } = buildListKeyboardAndText(longList.id, false);
  assert(longText.includes('Grocery\\_item\\_1'), 'Item 1 is present in text');
  assert(longText.includes('Grocery\\_item\\_15'), 'Item 15 is present in text');
  assert(longText.includes('Grocery\\_item\\_22'), 'Item 22 (>15) is present in text');
  assert(!longText.includes('more active items'), 'Does not truncate or show "...and X more active items"');

  const longButtonsFlat = longKeyboard.reply_markup.inline_keyboard.flat();
  const hasTrash = longButtonsFlat.some(b => b.text.includes('🗑️') || (b.callback_data && b.callback_data.startsWith('item:del:')));
  assert(!hasTrash, 'No delete buttons generated for 22 items');
  const toggleButtons = longButtonsFlat.filter(b => b.callback_data && b.callback_data.startsWith('item:toggle:'));
  assert(toggleButtons.length === 22, `All 22 item toggle buttons generated (got ${toggleButtons.length})`);

  console.log('\n=== 3. Markdown Entity Safety & Fallback Resilience ===');
  let fallbackPlainCalled = false;
  const mockCtx = {
    replyWithMarkdown: async (msg) => {
      // Simulate Telegram entity parse error when unmatched formatting is detected
      if (msg.includes('_unmatched') || msg.includes('*unmatched')) {
        const err = new Error("400: Bad Request: can't parse entities: Can't find end of the entity");
        throw err;
      }
      return { ok: true, text: msg };
    },
    reply: async (plain) => {
      fallbackPlainCalled = true;
      return { ok: true, text: plain };
    },
    editMessageText: async (msg, extra) => {
      if (extra && extra.parse_mode === 'Markdown' && (msg.includes('_unmatched') || msg.includes('*unmatched'))) {
        throw new Error("400: Bad Request: can't parse entities");
      }
      return { ok: true, text: msg };
    }
  };

  // Safe reply succeeds on clean markdown
  const res1 = await safeReplyMarkdown(mockCtx, '*Clean Bold*');
  assert(res1 && res1.ok, 'safeReplyMarkdown succeeds on valid markdown');

  // Safe reply gracefully falls back to plain text on parse error
  fallbackPlainCalled = false;
  const res2 = await safeReplyMarkdown(mockCtx, 'Danger _unmatched underscore string');
  assert(fallbackPlainCalled && res2 && res2.ok, 'safeReplyMarkdown fell back to plain text without throwing');

  // Safe edit falls back to plain text
  const res3 = await safeEditMarkdown(mockCtx, 'Danger *unmatched asterisk');
  assert(res3 && res3.ok, 'safeEditMarkdown fell back cleanly without throwing');

  console.log('\n=== 4. buildConfirmationMessage Escaping ===');
  const dummyProfile = { name: 'Charlie_Test' };
  const confMsg = buildConfirmationMessage({
    response_message: 'Updated Charlie_Test with [Special_Tag] item',
    tasks: [{ title: 'Fix_sink_leak', assignee: 'Charlie_Test' }]
  }, dummyProfile);

  assert(confMsg.includes('Charlie\\_Test'), 'Profile name in greeting escaped');
  assert(confMsg.includes('Fix\\_sink\\_leak'), 'Task title with underscores escaped');

  // Cleanup test DB
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${testDbPath}${suffix}`;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }

  if (failures > 0) {
    console.error(`\n❌ Tests failed with ${failures} failure(s).`);
    process.exit(1);
  } else {
    console.log(`\n🎉 All Telegram List Fixes Tests passed!`);
  }
}

runTests().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
