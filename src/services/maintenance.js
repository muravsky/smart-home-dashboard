const fs = require('fs');
const path = require('path');

const SUBSCRIPTION_TYPES = new Set(['morning_summary', 'evening_summary', 'librus_messages', 'librus_grades']);

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timeKey(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dateMatchesDue(date, weekday, time) {
  return date.getDay() === Number(weekday) && timeKey(date) === time;
}

function getDueLibrusSyncs(settings, date) {
  const today = dateKey(date);
  const hour = `${today}T${String(date.getHours()).padStart(2, '0')}`;
  const due = [];
  for (const key of ['librus_sync_timetable', 'librus_sync_grades', 'librus_sync_notifications', 'librus_sync_announcements', 'librus_sync_messages']) {
    const frequency = settings[key] || 'manual';
    const marker = `last_${key}`;
    if (frequency === 'hourly' && date.getMinutes() === 0 && settings[marker] !== hour) due.push({ key, marker, value: hour });
    if (frequency === 'daily' && timeKey(date) === (settings.librus_sync_time || '06:00') && settings[marker] !== today) due.push({ key, marker, value: today });
    if (frequency === 'weekly' && dateMatchesDue(date, settings.librus_sync_weekday ?? 1, settings.librus_sync_time || '06:00') && settings[marker] !== today) due.push({ key, marker, value: today });
  }
  return due;
}

function createMaintenanceService({
  db,
  bot,
  getSettings,
  updateSettings,
  pruneData,
  getSubscriptions,
  markSubscriptionSent,
  getLists,
  getSchedules,
  getLibrusData,
  getActiveMealMenu,
  getDishes,
  getPhotos,
  updatePhotoFilename,
  createPhotoDerivative,
  removePhotoFile,
  getWeather,
  buildSummary,
  syncLibrus,
  audit,
  backupDirectory = path.join(__dirname, '../../data/backups'),
  clock = () => new Date(),
  logger = console
}) {
  let timer = null;
  let running = false;

  function writeAudit(action, status, errorMessage = null, details = null) {
    if (typeof audit === 'function') {
      audit({
        source: 'scheduled_job',
        sender_name: 'Maintenance scheduler',
        message_type: 'scheduled',
        action_taken: action,
        status,
        error_message: errorMessage,
        parsed_payload: details
      });
    }
  }

  async function pruneBackups(keepCount) {
    await fs.promises.mkdir(backupDirectory, { recursive: true });
    const files = (await fs.promises.readdir(backupDirectory))
      .filter(name => /^dashboard-\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .sort()
      .reverse();
    const stale = files.slice(Math.max(1, Number(keepCount) || 4));
    for (const name of stale) await fs.promises.unlink(path.join(backupDirectory, name)).catch(() => {});
    return stale.length;
  }

  async function createWeeklyBackup(settings, today) {
    const filename = `dashboard-${dateKey(today)}.db`;
    const destination = path.join(backupDirectory, filename);
    try {
      await fs.promises.mkdir(backupDirectory, { recursive: true });
      await db.backup(destination);
      let delivered = false;
      if (bot && settings.weekly_backup_chat_id) {
        await bot.telegram.sendDocument(String(settings.weekly_backup_chat_id), { source: destination }, {
          caption: `Weekly dashboard database backup (${dateKey(today)}). Photos are stored separately and are not included.`
        });
        delivered = true;
      }
      const trimmed = await pruneBackups(settings.backup_retention_count);
      updateSettings({ last_weekly_backup_on: dateKey(today) });
      writeAudit('Weekly database backup created', delivered ? 'success' : 'partial', delivered ? null : 'Backup saved locally; Telegram bot or destination chat is not configured.', {
        filename,
        delivered,
        removedOldBackups: trimmed
      });
    } catch (error) {
      writeAudit('Weekly database backup failed', 'error', error.message, { filename });
      logger.error('[Maintenance] Weekly backup failed:', error.message);
    }
  }

  async function migrateExistingPhotos() {
    const photos = getPhotos();
    let converted = 0;
    let failed = 0;
    for (const photo of photos) {
      if (String(photo.filename).startsWith('screen-')) continue;
      try {
        const derivative = await createPhotoDerivative(photo.filename);
        if (derivative.optimized === false || derivative.filename === photo.filename) {
          failed++;
          continue;
        }
        updatePhotoFilename(photo.id, derivative.filename);
        await removePhotoFile(photo.filename);
        converted++;
      } catch (error) {
        failed++;
        logger.warn(`[Maintenance] Could not resize photo ${photo.id}:`, error.message);
      }
    }
    updateSettings({ photo_derivatives_migrated: failed ? 0 : 1, photo_derivative_migration_on: dateKey(clock()) });
    if (converted || failed) {
      writeAudit('Existing screensaver photos optimized', failed ? 'partial' : 'success', failed ? `${failed} photo(s) could not be optimized.` : null, { converted, failed });
    }
  }

  async function sendSubscription(subscription, today) {
    const profileName = subscription.profile_name || 'Family member';
    const chatId = subscription.telegram_id;
    if (!chatId || !bot) {
      throw new Error(`No Telegram destination is configured for ${profileName}`);
    }

    const librus = getLibrusData(subscription.profile_id);
    let text = '';
    let cursor = null;
    if (subscription.type === 'morning_summary') {
      const lists = getLists();
      const tasks = lists
        .filter(list => list.type === 'tasks')
        .flatMap(list => list.items || [])
        .filter(item => item.checked !== 1 && (!item.assignee_profile_id || Number(item.assignee_profile_id) === Number(subscription.profile_id)))
        .filter(item => !item.due_date || item.due_date === dateKey(today))
        .slice(0, 8);
      const schedule = getSchedules().find(item => Number(item.profile_id) === Number(subscription.profile_id));
      const weather = await getWeather().catch(() => null);
      text = buildSummary({
        weather,
        tasks,
        schedule: schedule ? schedule.schedule : [],
        grades: librus.grades,
        notifications: librus.notifications,
        announcements: librus.announcements,
        language: subscription.language || 'en'
      });
    } else if (subscription.type === 'evening_summary') {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowIso = dateKey(tomorrow);
      const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const tomorrowDayName = dayLabels[tomorrow.getDay()];
      const fullDayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const tomorrowFullDayName = fullDayLabels[tomorrow.getDay()];

      const scheduleObj = getSchedules().find(item => Number(item.profile_id) === Number(subscription.profile_id)) || getSchedules()[0];
      const scheduleDays = scheduleObj && Array.isArray(scheduleObj.schedule) ? scheduleObj.schedule : [];
      const dayEntry = scheduleDays.find(d => String(d.day).slice(0, 3).toLowerCase() === tomorrowDayName.toLowerCase());
      let tomorrowLessons = [];
      if (dayEntry) {
        if (dayEntry.nextDate === tomorrowIso && Array.isArray(dayEntry.nextLessons)) {
          tomorrowLessons = dayEntry.nextLessons;
        } else if ((today.getDay() === 0 || today.getDay() === 6) && Array.isArray(dayEntry.nextLessons) && dayEntry.nextLessons.length > 0) {
          tomorrowLessons = dayEntry.nextLessons;
        } else if (Array.isArray(dayEntry.lessons)) {
          tomorrowLessons = dayEntry.lessons;
        }
      }
      const activeLessons = tomorrowLessons.filter(l => !l.cancelled);

      let mealLines = [];
      if (typeof getActiveMealMenu === 'function') {
        const activeMenu = getActiveMealMenu();
        const dishMap = new Map(
          (typeof getDishes === 'function' ? getDishes() : []).map(d => [Number(d.id), d.name])
        );
        const dayPlan = (activeMenu && activeMenu.schedule)
          ? (activeMenu.schedule[tomorrowFullDayName] || activeMenu.schedule[tomorrowDayName] || Object.entries(activeMenu.schedule).find(([k]) => k.slice(0, 3).toLowerCase() === tomorrowDayName.toLowerCase())?.[1])
          : null;
        if (dayPlan) {
          for (const slot of activeMenu.meal_slots || ['Breakfast', 'Lunch', 'Dinner', 'Snack']) {
            const rawEntries = dayPlan[slot];
            const arr = Array.isArray(rawEntries) ? rawEntries : (rawEntries ? [rawEntries] : []);
            const names = arr.map(entry => {
              if (!entry) return null;
              if (typeof entry === 'string') return entry;
              if (entry.title || entry.custom_title || entry.custom_text || entry.name) {
                return entry.title || entry.custom_title || entry.custom_text || entry.name;
              }
              if (entry.dish_id && dishMap.has(Number(entry.dish_id))) return dishMap.get(Number(entry.dish_id));
              return null;
            }).filter(Boolean);
            if (names.length > 0) {
              mealLines.push(`• ${slot}: ${names.join(', ')}`);
            }
          }
        }
      }

      const lists = getLists();
      const pendingTasks = lists
        .filter(list => list.type === 'tasks')
        .flatMap(list => list.items || [])
        .filter(item => item.checked !== 1 && (!item.assignee_profile_id || Number(item.assignee_profile_id) === Number(subscription.profile_id)))
        .filter(item => !item.due_date || item.due_date <= tomorrowIso)
        .slice(0, 8);

      const parts = [`🌙 Evening Prep Summary for ${profileName} (${tomorrowDayName} ${tomorrowIso}):`];
      if (activeLessons.length > 0) {
        parts.push(`\n🎒 Tomorrow's Classes (${activeLessons.length}):\n` + activeLessons.map(l => `• ${l.start || ''} ${l.name}${l.room && l.room !== '—' ? ` (rm ${l.room})` : ''}`).join('\n'));
      } else {
        parts.push('\n🎒 Tomorrow\'s Classes: No classes scheduled.');
      }
      if (mealLines.length > 0) {
        parts.push(`\n🍽️ Tomorrow's Menu:\n` + mealLines.join('\n'));
      }
      if (pendingTasks.length > 0) {
        parts.push(`\n✅ Unfinished Tasks & Chores:\n` + pendingTasks.map(t => `• ${t.content}${t.reward ? ` (+${t.reward} ⭐)` : ''}`).join('\n'));
      }
      text = parts.join('\n');
    } else if (subscription.type === 'librus_messages') {
      const messages = (librus.messages || [])
        .filter(message => !subscription.last_cursor || Number(message.id) > Number(subscription.last_cursor))
        .slice(0, 8);
      if (!messages.length) {
        markSubscriptionSent(subscription.id, dateKey(today));
        return;
      }
      cursor = String(messages[messages.length - 1].id || subscription.last_cursor || '');
      text = `New Librus messages for ${profileName}:\n\n${messages.map(message => `• ${message.title || 'Message'}${message.user ? `, ${message.user}` : ''}${message.date ? ` (${message.date})` : ''}${message.content ? `\n${message.content}` : ''}`).join('\n\n')}`;
    } else if (subscription.type === 'librus_grades') {
      const grades = (librus.grades || []).filter(grade => String(grade.date || '').slice(0, 10) === dateKey(today));
      if (!grades.length) {
        markSubscriptionSent(subscription.id, dateKey(today));
        return;
      }
      text = `Today's Librus grades for ${profileName}:\n\n${grades.map(grade => `• ${grade.subject}: ${grade.value}${grade.date ? ` (${grade.date})` : ''}`).join('\n')}`;
    } else {
      return;
    }

    await bot.telegram.sendMessage(String(chatId), text.slice(0, 3900));
    markSubscriptionSent(subscription.id, dateKey(today), cursor);
    writeAudit(`Sent ${subscription.type} subscription to ${profileName}`, 'success', null, { profileId: subscription.profile_id });
  }

  async function runOnce(date = clock()) {
    if (running) return;
    running = true;
    try {
      let settings = getSettings();
      const today = dateKey(date);
      if (!Number(settings.photo_derivatives_migrated) && settings.photo_derivative_migration_on !== today && getPhotos && createPhotoDerivative && updatePhotoFilename && removePhotoFile) {
        await migrateExistingPhotos();
        settings = getSettings();
      }
      if (settings.maintenance_pruned_on !== today) {
        const removed = pruneData({
          auditDays: settings.audit_retention_days,
          notesDays: settings.notes_retention_days,
          completedTaskDays: settings.completed_items_retention_days
        });
        db.pragma('wal_checkpoint(TRUNCATE)');
        settings = updateSettings({ maintenance_pruned_on: today });
        writeAudit('Database retention cleanup completed', 'success', null, removed);
      }

      const currentMonth = today.slice(0, 7);
      if (date.getDate() === 1 && settings.maintenance_vacuumed_month !== currentMonth) {
        db.exec('VACUUM');
        updateSettings({ maintenance_vacuumed_month: currentMonth });
        writeAudit('SQLite database compacted', 'success');
      }

      if (Number(settings.weekly_backup_enabled) && settings.last_weekly_backup_on !== today && dateMatchesDue(date, settings.weekly_backup_weekday, settings.weekly_backup_time || '08:00')) {
        await createWeeklyBackup(settings, date);
      }

      const dueLibrusSyncs = getDueLibrusSyncs(settings, date);
      if (dueLibrusSyncs.length && syncLibrus) {
        updateSettings(Object.fromEntries(dueLibrusSyncs.map(item => [item.marker, item.value])));
        try {
          await syncLibrus(dueLibrusSyncs.map(item => item.key));
          writeAudit(`Scheduled Librus sync completed (${dueLibrusSyncs.map(item => item.key.replace('librus_sync_', '')).join(', ')})`, 'success');
        } catch (error) {
          writeAudit('Scheduled Librus sync failed', 'error', error.message);
        }
      }

      const messageSubscriptionDue = getSubscriptions().some(subscription => subscription.enabled && subscription.type === 'librus_messages' && subscription.send_time === timeKey(date) && subscription.last_sent_on !== today);
      if (messageSubscriptionDue && !dueLibrusSyncs.some(item => item.key === 'librus_sync_messages') && syncLibrus) {
        try {
          await syncLibrus(['librus_sync_messages']);
          writeAudit('Refreshed Librus inbox before scheduled message delivery', 'success');
        } catch (error) {
          writeAudit('Librus inbox refresh before subscription failed', 'error', error.message);
        }
      }

      for (const subscription of getSubscriptions()) {
        if (!subscription.enabled || subscription.send_time !== timeKey(date) || subscription.last_sent_on === today) continue;
        try {
          await sendSubscription(subscription, date);
        } catch (error) {
          writeAudit(`Scheduled ${subscription.type} delivery failed`, 'error', error.message, { profileId: subscription.profile_id });
          logger.error('[Maintenance] Subscription delivery failed:', error.message);
        }
      }
    } catch (error) {
      writeAudit('Maintenance cycle failed', 'error', error.message);
      logger.error('[Maintenance] Cycle failed:', error.message);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    runOnce();
    timer = setInterval(() => runOnce(), 30 * 1000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, pruneBackups };
}

module.exports = { SUBSCRIPTION_TYPES, dateKey, timeKey, dateMatchesDue, getDueLibrusSyncs, createMaintenanceService };
