const assert = require('assert');
const {
  db,
  insertCalendarFeed,
  deleteCalendarFeed,
  upsertCalendarEventByUid,
  cleanDuplicateCalendarEvents,
  deleteObsoleteFeedEvents,
  getCalendarEvents
} = require('../src/db');

console.log('=== Calendar Sync Deduplication & Stability Tests ===\n');

// 1. Create a dummy test feed
const feed = insertCalendarFeed({
  name: 'Unit Test Feed',
  ical_url: 'https://example.com/test-cal.ics',
  color: '#3b82f6'
});
assert(feed && feed.id, 'Feed should be created');
console.log('✅ Created test calendar feed #', feed.id);

try {
  // 2. Simulate First Sync Run (Window Day 0 to Day 90)
  // Base recurring event: Daily standup at 09:00:00Z for 3 days
  const baseUid = 'recurring-standup-xyz@google.com';
  const day1Start = '2026-10-20T09:00:00.000Z';
  const day2Start = '2026-10-21T09:00:00.000Z';
  const day3Start = '2026-10-22T09:00:00.000Z';

  const uidDay1 = `feed-${feed.id}-${baseUid}_${day1Start}`;
  const uidDay2 = `feed-${feed.id}-${baseUid}_${day2Start}`;
  const uidDay3 = `feed-${feed.id}-${baseUid}_${day3Start}`;

  upsertCalendarEventByUid({
    uid: uidDay1,
    feed_id: feed.id,
    title: 'Daily Standup',
    start_datetime: day1Start,
    end_datetime: '2026-10-20T09:30:00.000Z',
    all_day: 0
  });

  upsertCalendarEventByUid({
    uid: uidDay2,
    feed_id: feed.id,
    title: 'Daily Standup',
    start_datetime: day2Start,
    end_datetime: '2026-10-21T09:30:00.000Z',
    all_day: 0
  });

  upsertCalendarEventByUid({
    uid: uidDay3,
    feed_id: feed.id,
    title: 'Daily Standup',
    start_datetime: day3Start,
    end_datetime: '2026-10-22T09:30:00.000Z',
    all_day: 0
  });

  let events = db.prepare('SELECT * FROM calendar_events WHERE feed_id = ?').all(feed.id);
  assert.strictEqual(events.length, 3, 'Initial sync should create exactly 3 events');
  console.log('✅ Initial sync created 3 events');

  // 3. Simulate Second Sync Run (Simulate sliding window or subsequent cron sync)
  // Same event occurrences re-synced
  upsertCalendarEventByUid({
    uid: uidDay1,
    feed_id: feed.id,
    title: 'Daily Standup',
    description: 'Updated description from Google Calendar',
    start_datetime: day1Start,
    end_datetime: '2026-10-20T09:30:00.000Z',
    all_day: 0
  });

  upsertCalendarEventByUid({
    uid: uidDay2,
    feed_id: feed.id,
    title: 'Daily Standup',
    start_datetime: day2Start,
    end_datetime: '2026-10-21T09:30:00.000Z',
    all_day: 0
  });

  upsertCalendarEventByUid({
    uid: uidDay3,
    feed_id: feed.id,
    title: 'Daily Standup',
    start_datetime: day3Start,
    end_datetime: '2026-10-22T09:30:00.000Z',
    all_day: 0
  });

  events = db.prepare('SELECT * FROM calendar_events WHERE feed_id = ?').all(feed.id);
  assert.strictEqual(events.length, 3, 'Second sync must NOT create duplicate rows');
  assert.strictEqual(events.find(e => e.start_datetime === day1Start).description, 'Updated description from Google Calendar');
  console.log('✅ Subsequent sync updated in-place with 0 duplicates');

  // 4. Test In-place Matching if old legacy sliding UID format was in database
  // E.g. legacy UID was `recurring-standup-xyz@google.com_2026-10-20_0`
  db.prepare(`
    INSERT INTO calendar_events (uid, feed_id, title, start_datetime, color, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('recurring-standup-xyz@google.com_2026-10-23_0', feed.id, 'Daily Standup', '2026-10-23T09:00:00.000Z', '#38bdf8', 'google');

  // Now sync runs with the new deterministic UID format:
  const newFormatUid = `feed-${feed.id}-${baseUid}_2026-10-23T09:00:00.000Z`;
  upsertCalendarEventByUid({
    uid: newFormatUid,
    feed_id: feed.id,
    title: 'Daily Standup',
    description: 'Adopted canonical UID',
    start_datetime: '2026-10-23T09:00:00.000Z',
    end_datetime: '2026-10-23T09:30:00.000Z',
    all_day: 0
  });

  const matchingRows = db.prepare('SELECT * FROM calendar_events WHERE feed_id = ? AND start_datetime = ?').all(feed.id, '2026-10-23T09:00:00.000Z');
  assert.strictEqual(matchingRows.length, 1, 'Legacy UID should be updated in-place without creating a duplicate row');
  assert.strictEqual(matchingRows[0].uid, newFormatUid, 'Canonical UID should be adopted');
  console.log('✅ Legacy sliding UID matched in-place and upgraded to deterministic UID');

  // 5. Test cleanDuplicateCalendarEvents
  // Manually force an artificial duplicate into the DB
  db.prepare(`
    INSERT INTO calendar_events (uid, feed_id, title, start_datetime, color, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('artificial-duplicate-uid', feed.id, 'Daily Standup', day1Start, '#38bdf8', 'google');

  let dupCheck = db.prepare('SELECT count(*) as cnt FROM calendar_events WHERE feed_id = ? AND start_datetime = ?').get(feed.id, day1Start);
  assert.strictEqual(dupCheck.cnt, 2, 'Should have 2 rows before clean');

  const cleanResult = cleanDuplicateCalendarEvents();
  assert(cleanResult.feedDuplicatesRemoved >= 1, 'cleanDuplicateCalendarEvents should remove feed duplicates');

  dupCheck = db.prepare('SELECT count(*) as cnt FROM calendar_events WHERE feed_id = ? AND start_datetime = ?').get(feed.id, day1Start);
  assert.strictEqual(dupCheck.cnt, 1, 'Should have exactly 1 row after clean');
  console.log('✅ cleanDuplicateCalendarEvents successfully purged duplicate records');

  // 6. Test deleteObsoleteFeedEvents (event deleted from Google Calendar)
  // Suppose day3 event is removed from Google Calendar feed
  const activeUids = [uidDay1, uidDay2, newFormatUid];
  const obsoleteResult = deleteObsoleteFeedEvents(
    feed.id,
    activeUids,
    '2026-10-01T00:00:00.000Z',
    '2026-11-01T00:00:00.000Z'
  );

  assert.strictEqual(obsoleteResult.changes, 1, 'Obsolete event (day 3) should be deleted');
  const remainingDay3 = db.prepare('SELECT * FROM calendar_events WHERE uid = ?').get(uidDay3);
  assert.strictEqual(remainingDay3, undefined, 'Deleted event must no longer exist in DB');
  console.log('✅ deleteObsoleteFeedEvents pruned deleted Google Calendar event');

  console.log('\n🎉 ALL CALENDAR DEDUPLICATION TESTS PASSED SUCCESSFULLY!');
} finally {
  // Cleanup test feed and its events
  db.prepare('DELETE FROM calendar_events WHERE feed_id = ?').run(feed.id);
  deleteCalendarFeed(feed.id);
}
