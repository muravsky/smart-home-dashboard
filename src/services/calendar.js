const ical = require('node-ical');
const {
  getCalendarFeeds,
  clearCalendarFeedProfileIfMissing,
  updateCalendarFeedSyncTime,
  upsertCalendarEventByUid,
  deleteOldCalendarEventsByFeed,
  deleteOldCalendarEvents,
  getDashboardData,
  insertAuditLog
} = require('../db');

/**
 * Normalize calendar URL (handles webcal:// and extracts Google Calendar ID from cid web URLs)
 * @param {string} url
 * @returns {string}
 */
function normalizeCalendarUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let clean = url.trim();
  if (clean.startsWith('webcal://')) {
    clean = 'https://' + clean.slice(9);
  }
  try {
    const parsed = new URL(clean);
    if (parsed.hostname.includes('calendar.google.com') && parsed.searchParams.has('cid')) {
      let cid = parsed.searchParams.get('cid');
      if (cid && !cid.includes('@')) {
        try {
          const decoded = Buffer.from(cid, 'base64').toString('utf-8');
          if (decoded && decoded.includes('@')) {
            cid = decoded;
          }
        } catch(e) {}
      }
      if (cid && cid.includes('@')) {
        return `https://calendar.google.com/calendar/ical/${encodeURIComponent(cid)}/public/basic.ics`;
      }
    }
  } catch(e) {}
  return clean;
}

/**
 * Synchronize a single iCal feed (Google Calendar, Apple, Outlook)
 * @param {object} feed - Feed record from calendar_feeds table
 * @returns {Promise<number>} Number of events synced
 */
async function syncFeed(feed) {
  if (!feed || !feed.ical_url) return 0;
  const feedUrl = normalizeCalendarUrl(feed.ical_url);
  const redactedUrl = (() => {
    try { return new URL(feedUrl).origin; } catch (error) { return '[invalid URL]'; }
  })();
  const profileRepair = clearCalendarFeedProfileIfMissing(feed.id);
  if (profileRepair.changes) {
    insertAuditLog({
      source: 'calendar_sync',
      sender_name: feed.name,
      message_type: 'feed_profile_repair',
      action_taken: 'Detached calendar feed from a deleted profile; events will be shared with the family',
      status: 'partial',
      error_message: `Orphaned profile_id on calendar feed ${feed.id} was cleared.`
    });
    feed.profile_id = null;
    console.warn(`[Calendar] Feed #${feed.id} "${feed.name}" had a deleted profile assignment; cleared it.`);
  }
  console.log(`[Calendar] Syncing feed #${feed.id} "${feed.name}" from ${redactedUrl}...`);

  try {
    const data = await ical.async.fromURL(feedUrl);
    let count = 0;

    const now = new Date();
    // Expand recurring events from 30 days ago to 90 days in the future
    const rangeFrom = new Date(now.getTime() - 30 * 86400000);
    const rangeTo = new Date(now.getTime() + 90 * 86400000);

    for (const key of Object.keys(data)) {
      const item = data[key];
      if (item.type !== 'VEVENT') continue;

      const baseUid = item.uid || `ical-${feed.id}-${key}`;
      const title = item.summary || 'Untitled Event';
      const description = item.description || null;

      // If the event has an RRULE (recurring event), expand occurrences within window
      if (item.rrule && typeof ical.expandRecurringEvent === 'function') {
        let instances = null;
        try {
          instances = ical.expandRecurringEvent(item, { from: rangeFrom, to: rangeTo });
        } catch (rruleErr) {
          console.warn(`[Calendar] Failed to expand recurring event "${title}":`, rruleErr.message);
        }
        if (instances) {
          for (let idx = 0; idx < instances.length; idx++) {
            const inst = instances[idx];
            const instStart = inst.start instanceof Date ? inst.start.toISOString() : new Date(inst.start).toISOString();
            const instEnd = inst.end ? (inst.end instanceof Date ? inst.end.toISOString() : new Date(inst.end).toISOString()) : null;
            const isAllDay = inst.datetype === 'date' || (inst.start && typeof inst.start.toISOString === 'function' && inst.start.toISOString().endsWith('T00:00:00.000Z') && inst.end && (inst.end - inst.start) % 86400000 === 0) ? 1 : 0;

            upsertCalendarEventByUid({
              uid: `${baseUid}_${instStart.slice(0, 10)}_${idx}`,
              feed_id: feed.id,
              title,
              description,
              start_datetime: instStart,
              end_datetime: instEnd,
              all_day: isAllDay,
              profile_id: feed.profile_id || null,
              color: feed.color || '#38bdf8',
              source: 'google'
            });
            count++;
          }
          continue;
        }
      }

      let startIso = null;
      let endIso = null;
      let allDay = 0;

      if (item.start) {
        startIso = item.start instanceof Date ? item.start.toISOString() : new Date(item.start).toISOString();
      } else {
        continue;
      }

      // Skip past one-off events older than 60 days to keep calendar relevant
      const eventStartDate = new Date(startIso);
      if (eventStartDate < new Date(now.getTime() - 60 * 86400000)) {
        continue;
      }

      if (item.end) {
        endIso = item.end instanceof Date ? item.end.toISOString() : new Date(item.end).toISOString();
      }

      if (item.datetype === 'date' || (item.start && typeof item.start.toISOString === 'function' && item.start.toISOString().endsWith('T00:00:00.000Z') && item.end && (item.end - item.start) % 86400000 === 0)) {
        allDay = 1;
      }

      upsertCalendarEventByUid({
        uid: baseUid,
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

    // Clean up stale past events for this feed older than 60 days
    const purgeCutoff = new Date(now.getTime() - 60 * 86400000).toISOString();
    deleteOldCalendarEventsByFeed(feed.id, purgeCutoff);

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
  let failedFeeds = 0;
  for (const feed of feeds) {
    try {
      const c = await syncFeed(feed);
      totalEvents += c;
    } catch (e) {
      failedFeeds++;
    }
  }

  // Purge any orphaned or old synced events older than 60 days
  const purgeCutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  const purged = deleteOldCalendarEvents(purgeCutoff);

  insertAuditLog({
    source: 'scheduled_job',
    sender_name: 'Calendar Sync',
    message_type: 'calendar_sync',
    action_taken: `Calendar feed sync: ${feeds.length - failedFeeds}/${feeds.length} feeds succeeded, ${totalEvents} events updated, ${purged.changes || 0} expired events removed`,
    status: failedFeeds ? 'partial' : 'success',
    error_message: failedFeeds ? `${failedFeeds} feed(s) failed; see server logs for details.` : null
  });

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
  normalizeCalendarUrl,
  syncFeed,
  syncAllFeeds,
  startCalendarSyncCron
};
