const ical = require('node-ical');
const {
  getCalendarFeeds,
  updateCalendarFeedSyncTime,
  upsertCalendarEventByUid,
  getDashboardData
} = require('../db');

/**
 * Synchronize a single iCal feed (Google Calendar, Apple, Outlook)
 * @param {object} feed - Feed record from calendar_feeds table
 * @returns {Promise<number>} Number of events synced
 */
async function syncFeed(feed) {
  if (!feed || !feed.ical_url) return 0;
  console.log(`[Calendar] Syncing feed #${feed.id} "${feed.name}" from ${feed.ical_url}...`);

  try {
    const data = await ical.async.fromURL(feed.ical_url);
    let count = 0;

    for (const key of Object.keys(data)) {
      const item = data[key];
      if (item.type !== 'VEVENT') continue;

      const uid = item.uid || `ical-${feed.id}-${key}`;
      const title = item.summary || 'Untitled Event';
      const description = item.description || null;

      let startIso = null;
      let endIso = null;
      let allDay = 0;

      if (item.start) {
        startIso = item.start instanceof Date ? item.start.toISOString() : new Date(item.start).toISOString();
      } else {
        continue;
      }

      if (item.end) {
        endIso = item.end instanceof Date ? item.end.toISOString() : new Date(item.end).toISOString();
      }

      if (item.datetype === 'date' || (item.start && typeof item.start.toISOString === 'function' && item.start.toISOString().endsWith('T00:00:00.000Z') && item.end && (item.end - item.start) % 86400000 === 0)) {
        allDay = 1;
      }

      upsertCalendarEventByUid({
        uid,
        feed_id: feed.id,
        title,
        description,
        start_datetime: startIso,
        end_datetime: endIso,
        all_day: allDay,
        profile_id: feed.profile_id || null,
        color: feed.color || '#38bdf8',
        source: 'google'
      });

      count++;
    }

    updateCalendarFeedSyncTime(feed.id);
    console.log(`[Calendar] Feed #${feed.id} "${feed.name}" sync complete: ${count} events.`);
    return count;
  } catch (err) {
    console.error(`[Calendar] Failed to sync feed #${feed.id} "${feed.name}":`, err.message);
    throw err;
  }
}

/**
 * Synchronize all configured iCal feeds and broadcast to connected tablets
 * @param {import('socket.io').Server} [io]
 */
async function syncAllFeeds(io = null) {
  const feeds = getCalendarFeeds();
  if (feeds.length === 0) return { syncedFeeds: 0, totalEvents: 0 };

  let totalEvents = 0;
  for (const feed of feeds) {
    try {
      const c = await syncFeed(feed);
      totalEvents += c;
    } catch (e) {
      // Continue to next feed even if one fails
    }
  }

  if (io) {
    io.emit('dashboard_update', getDashboardData());
  }

  return { syncedFeeds: feeds.length, totalEvents };
}

/**
 * Start periodic 15-minute background synchronization
 * @param {import('socket.io').Server} io
 * @param {number} intervalMs - Defaults to 15 minutes
 */
function startCalendarSyncCron(io, intervalMs = 15 * 60 * 1000) {
  // Initial sync attempt in background
  setTimeout(() => {
    syncAllFeeds(io).catch((err) => console.warn('[Calendar] Initial sync error:', err.message));
  }, 3000);

  const timer = setInterval(() => {
    syncAllFeeds(io).catch((err) => console.warn('[Calendar] Periodic sync error:', err.message));
  }, intervalMs);

  return timer;
}

module.exports = {
  syncFeed,
  syncAllFeeds,
  startCalendarSyncCron
};
