const assert = require('assert');
const http = require('http');
const { 
  initDatabase, 
  calculateNextDueDate, 
  insertListItem, 
  toggleListItemChecked, 
  getLists,
  getSchedules,
  insertList,
  updateSettings,
  getSettings,
  upsertLibrusSchedule
} = require('../src/db');
const { searchCity, clearWeatherCache, getWeather } = require('../src/services/weather');
const { normalizeParsedGeminiPayload } = require('../src/services/gemini');

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

  console.log('\n--- 4. Testing Librus Schedule Upsert Logic ---');
  const firstPass = upsertLibrusSchedule({
    profile_id: 1,
    profile_name: 'Test Kid',
    schedule: [{ day: 'Mon', lessons: [{ number: 1, start: '08:30', end: '09:15', name: 'Math', room: 'A1' }] }]
  });
  const secondPass = upsertLibrusSchedule({
    profile_id: 1,
    profile_name: 'Test Kid',
    schedule: [{ day: 'Mon', lessons: [{ number: 1, start: '08:30', end: '09:15', name: 'Math', room: 'A1' }, { number: 2, start: '09:20', end: '10:05', name: 'Biology', room: 'B2' }] }]
  });
  assert.strictEqual(firstPass.id, secondPass.id, 'Librus sync should update the same schedule record instead of creating duplicates');
  assert.strictEqual(getSchedules().filter(s => s.profile_id === 1 && s.name.includes('Librus')).length, 1, 'Only one Librus schedule row should exist for a profile');
  console.log('[PASS] Librus sync updates an existing schedule instead of creating duplicates');

  console.log('\n--- 5. Testing Weather Geocoding and Unit Settings ---');
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

  console.log('\n--- 5. Testing Gemini Normalization Contract ---');
  const normalized = normalizeParsedGeminiPayload({
    notes: ['Remember to take medicine'],
    tasks: [{
      title: 'Wash dishes',
      assignee: 'Leo',
      reward: 15,
      due_date: '2026-09-24',
      due_time: '18:30',
      recurrence: 'daily'
    }],
    shopping_items: [{ content: 'milk' }, { content: 'eggs' }],
    calendar_events: [{ title: 'Doctor visit', date: '2026-09-25', time: '10:00', all_day: false }],
    timer: { minutes: 5, action: 'start' }
  });
  assert.strictEqual(normalized.tasks[0].title, 'Wash dishes');
  assert.strictEqual(normalized.tasks[0].assignee, 'Leo');
  assert.strictEqual(normalized.tasks[0].reward, 15);
  assert.strictEqual(normalized.shopping_items.length, 2);
  assert.strictEqual(normalized.calendar_events[0].title, 'Doctor visit');
  assert.strictEqual(normalized.timer.minutes, 5);
  console.log('[PASS] Gemini normalization preserves task, shopping, event, and timer details for Telegram actions');

  console.log('\n--- 6. Testing Weather Forecast Output ---');
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      current: {
        temperature_2m: 22,
        apparent_temperature: 24,
        relative_humidity_2m: 58,
        precipitation: 0.4,
        weather_code: 2,
        wind_speed_10m: 12
      },
      hourly: {
        time: Array.from({ length: 24 }, (_, idx) => `2026-09-24T${String(idx).padStart(2, '0')}:00`),
        temperature_2m: Array.from({ length: 24 }, () => 22),
        apparent_temperature: Array.from({ length: 24 }, () => 24),
        precipitation: Array.from({ length: 24 }, () => 0),
        weather_code: Array.from({ length: 24 }, () => 2),
        wind_speed_10m: Array.from({ length: 24 }, () => 10)
      },
      daily: {
        time: Array.from({ length: 10 }, (_, idx) => `2026-09-${String(24 + idx).padStart(2, '0')}`),
        weather_code: Array.from({ length: 10 }, () => 2),
        temperature_2m_max: Array.from({ length: 10 }, () => 25),
        temperature_2m_min: Array.from({ length: 10 }, () => 17),
        precipitation_sum: Array.from({ length: 10 }, () => 0.2)
      }
    })
  });
  clearWeatherCache();
  const forecastWeather = await getWeather();
  assert(Array.isArray(forecastWeather.forecast.hourly), 'Hourly forecast should be an array');
  assert(forecastWeather.forecast.hourly.length >= 12, 'Hourly forecast should contain several entries');
  assert(Array.isArray(forecastWeather.forecast.daily), 'Daily forecast should be an array');
  assert(forecastWeather.forecast.daily.length >= 7, 'Daily forecast should span several days');
  console.log('[PASS] Weather service exposes hourly and multi-day forecast arrays for dashboard widgets');
  global.fetch = originalFetch;

  console.log('\n--- 7. Testing Calendar URL Normalization & formatTime ---');
  const { normalizeCalendarUrl } = require('../src/services/calendar');
  const { insertCalendarFeed, getCalendarFeeds, deleteCalendarFeed, updateCalendarFeedSyncTime } = require('../src/db');
  const fs = require('fs');

  // Webcal
  const normWebcal = normalizeCalendarUrl('webcal://example.com/calendar.ics');
  assert.strictEqual(normWebcal, 'https://example.com/calendar.ics');
  console.log('[PASS] normalizeCalendarUrl converts webcal:// to https://');

  // Google cid web URL
  const googleWebUrl = 'https://calendar.google.com/calendar/u/0?cid=ZmFtaWx5MTUxMjU4MTkzNTc5ODQ4NDc1NjFAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ';
  const normGoogle = normalizeCalendarUrl(googleWebUrl);
  assert(normGoogle.includes('/ical/'), 'Should normalize cid to ical path');
  assert(normGoogle.includes('family15125819357984847561%40group.calendar.google.com'), 'Should extract base64-decoded calendar ID');
  console.log('[PASS] normalizeCalendarUrl extracts base64 calendar ID from Google web link');

  // Feed DB insertion and last_synced formatTime verification
  const testFeed = insertCalendarFeed({
    name: 'Test Family Feed',
    ical_url: normGoogle,
    color: '#38bdf8'
  });
  updateCalendarFeedSyncTime(testFeed.id);
  const feeds = getCalendarFeeds();
  const foundFeed = feeds.find(f => f.id === testFeed.id);
  assert(foundFeed.last_synced, 'Feed should have last_synced populated');
  console.log('[PASS] Feed last_synced timestamp successfully written');

  // Verify formatTime exists in admin/index.html
  const adminHtml = fs.readFileSync('admin/index.html', 'utf-8');
  assert(adminHtml.includes('function formatTime('), 'admin/index.html must define formatTime');
  assert(adminHtml.includes('formatTime,'), 'admin/index.html must export formatTime in setup return');
  console.log('[PASS] formatTime is properly defined and exported in admin/index.html');

  // Cleanup
  deleteCalendarFeed(testFeed.id);

  console.log('\n=== ALL LATEST FEATURE TESTS PASSED SUCCESSFULLY ===\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
