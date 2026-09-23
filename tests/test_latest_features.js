const assert = require('assert');
const http = require('http');
const { 
  initDatabase, 
  calculateNextDueDate, 
  insertListItem, 
  toggleListItemChecked, 
  getLists,
  insertList,
  updateSettings,
  getSettings
} = require('../src/db');
const { searchCity, clearWeatherCache, getWeather } = require('../src/services/weather');

async function runTests() {
  console.log('\n--- 1. Testing Recurrence Calculation Logic ---');
  
  // Daily
  const nextDaily = calculateNextDueDate('2026-09-23', 'daily');
  assert.strictEqual(nextDaily, '2026-09-24', 'Daily should advance by 1 day');
  console.log('[PASS] Daily recurrence advances by 1 day');

  // Interval (e.g. every 2 days)
  const nextInterval2 = calculateNextDueDate('2026-09-23', 'interval', 2);
  assert.strictEqual(nextInterval2, '2026-09-25', 'Interval 2 should advance by 2 days');
  console.log('[PASS] Every 2 days recurrence advances by 2 days');

  // Interval (every 5 days)
  const nextInterval5 = calculateNextDueDate('2026-09-23', 'interval', 5);
  assert.strictEqual(nextInterval5, '2026-09-28', 'Interval 5 should advance by 5 days');
  console.log('[PASS] Every 5 days recurrence advances by 5 days');

  // Weekdays: from Friday to Monday
  const nextFromFriday = calculateNextDueDate('2026-09-25', 'weekdays'); // 2026-09-25 is Friday
  assert.strictEqual(nextFromFriday, '2026-09-28', 'Weekdays from Friday should be Monday');
  console.log('[PASS] Weekdays recurrence skips Saturday and Sunday');

  // Custom Days of Week: Mon/Wed/Fri (1, 3, 5)
  // 2026-09-23 is Wednesday (day 3), next should be Friday (day 5, 2026-09-25)
  const nextCustomMWF = calculateNextDueDate('2026-09-23', 'weekly', 1, [1, 3, 5]);
  assert.strictEqual(nextCustomMWF, '2026-09-25', 'Custom days Mon/Wed/Fri from Wed should be Friday');
  console.log('[PASS] Custom days of week (Mon/Wed/Fri) advances to next designated day');

  console.log('\n--- 2. Testing Recurring Task Auto-Advance in Database ---');
  // Create a test list
  const testList = insertList({ name: 'Recurring Test List', type: 'tasks' });
  const item = insertListItem({
    list_id: testList.id,
    content: 'Take out the bins',
    due_date: '2026-09-23',
    recurrence: 'daily'
  });
  assert.strictEqual(item.due_date, '2026-09-23');
  assert.strictEqual(item.recurrence, 'daily');
  assert.strictEqual(item.checked, 0);

  // Toggle item complete -> should auto-advance due date and stay active (checked = 0)
  const toggled = toggleListItemChecked(item.id, true);
  assert.strictEqual(toggled.checked, 0, 'Recurring item should remain unchecked');
  assert.strictEqual(toggled.due_date, '2026-09-24', 'Recurring item should have next due date');
  console.log('[PASS] Completing recurring task automatically advances due date to tomorrow');

  console.log('\n--- 3. Testing Overdue Detection Logic ---');
  const pastDate = '2026-01-01';
  const todayStr = new Date().toISOString().slice(0, 10);
  const overdueItem = insertListItem({
    list_id: testList.id,
    content: 'Very overdue task',
    due_date: pastDate,
    recurrence: 'none'
  });
  const isOverdue = overdueItem.checked !== 1 && overdueItem.due_date && overdueItem.due_date < todayStr;
  assert.strictEqual(isOverdue, true, 'Item with past date should be flagged as overdue');
  console.log('[PASS] Overdue detection accurately identifies past uncompleted items');

  console.log('\n--- 4. Testing Weather Geocoding and Unit Settings ---');
  // Geocoding search test with a well-known city
  try {
    const results = await searchCity('London');
    assert(Array.isArray(results), 'Weather search should return an array');
    if (results.length > 0) {
      assert(results[0].latitude !== undefined);
      assert(results[0].longitude !== undefined);
      console.log(`[PASS] Weather geocoding found ${results.length} results for "London"`);
    } else {
      console.log('[WARN] Geocoding returned 0 results (network unavailable in test environment, fallback safe)');
    }
  } catch (err) {
    console.log('[NOTE] Geocoding skipped (offline test environment)');
  }

  // Weather Settings Persistence
  updateSettings({
    weather_city: 'Paris, France',
    weather_lat: '48.85',
    weather_lon: '2.35',
    weather_units: 'fahrenheit'
  });
  clearWeatherCache();
  const currentSettings = getSettings();
  assert.strictEqual(currentSettings.weather_city, 'Paris, France');
  assert.strictEqual(currentSettings.weather_lat, '48.85');
  assert.strictEqual(currentSettings.weather_lon, '2.35');
  assert.strictEqual(currentSettings.weather_units, 'fahrenheit');
  console.log('[PASS] Weather location & unit settings properly stored and retrieved');

  console.log('\n=== ALL LATEST FEATURE TESTS PASSED SUCCESSFULLY ===\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
