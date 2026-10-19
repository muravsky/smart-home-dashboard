const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { createScreensaverDerivative } = require('./middleware/upload');
const { parseTextWithGemini, parseAudioWithGemini } = require('./services/gemini');
const { fetchLibrusData, normalizeTimetableData, buildMorningSummary } = require('./services/librus');
const {
  insertNote,
  updateNote,
  deleteNote,
  getNotes,
  insertTask,
  getTasks,
  updateTaskStatus,
  updateTask,
  deleteTask,
  getDashboardData,
  insertPhoto,
  getPhotos,
  getCalendarEvents,
  insertCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getProfileByTelegramId,
  getProfileById,
  getProfiles,
  getLists,
  getListById,
  insertList,
  insertListItem,
  updateList,
  updateListItem,
  deleteListItem,
  clearCompletedListItems,
  toggleListItemChecked,
  getDishes,
  getDishById,
  insertDish,
  getDefaultMealSlots,
  getMealMenus,
  getMealMenuById,
  getActiveMealMenu,
  setMealSlotEntry,
  getRewards,
  redeemReward,
  insertAuditLog,
  getCalendarFeeds
} = require('./db');

// Save a Telegram photo to disk and DB
async function saveTelegramPhoto(ctx, io) {
  try {
    const photosDir = path.join(__dirname, '../public/uploads/photos');
    if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });

    // Pick highest-resolution photo
    const photoArr = ctx.message.photo;
    const fileRef = photoArr[photoArr.length - 1];
    const caption = ctx.message.caption || null;

    // Get download URL from Telegram API
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileRef.file_id}`;

    const fileInfo = await new Promise((resolve, reject) => {
      https.get(fileInfoUrl, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
        res.on('error', reject);
      });
    });

    const filePath = fileInfo.result.file_path;
    const ext = path.extname(filePath) || '.jpg';
    const filename = `photo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-tg${ext}`;
    const destPath = path.join(photosDir, filename);

    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(destPath);
      https.get(downloadUrl, (res) => {
        res.pipe(dest);
        dest.on('finish', () => { dest.close(); resolve(); });
        dest.on('error', reject);
      });
    });

    const derivative = await createScreensaverDerivative(destPath, filename);
    if (derivative.optimized) await fs.promises.unlink(destPath).catch(() => {});

    const photo = insertPhoto({
      filename: derivative.filename,
      original_name: filename,
      source: 'telegram',
      caption,
      show_in_screensaver: 1,
      telegram_file_id: fileRef.file_id
    });

    io.emit('dashboard_update', getDashboardData());

    console.log(`[Telegram] Photo saved: ${filename}`);
    return photo;
  } catch (err) {
    console.error('[Telegram] Failed to save photo:', err.message);
    throw err;
  }
}

function escapeMd(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/([_*`\[\]()])/g, '\\$1');
}

async function safeReplyMarkdown(ctx, text, extra = {}) {
  try {
    return await ctx.replyWithMarkdown(text, extra);
  } catch (err) {
    console.warn('[Telegram] replyWithMarkdown failed, falling back to plain text:', err.message);
    try {
      const plainText = text.replace(/[*_`\\]/g, '');
      return await ctx.reply(plainText, extra);
    } catch (err2) {
      console.error('[Telegram] Failed to send fallback message:', err2.message);
    }
  }
}

async function safeEditMarkdown(ctx, text, extra = {}) {
  try {
    return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...(extra || {}) });
  } catch (err) {
    console.warn('[Telegram] editMessageText failed with Markdown, trying plain text:', err.message);
    try {
      const plainText = text.replace(/[*_`\\]/g, '');
      return await ctx.editMessageText(plainText, extra || {});
    } catch (err2) {
      console.warn('[Telegram] editMessageText plain failed, falling back to reply:', err2.message);
      return await safeReplyMarkdown(ctx, text, extra);
    }
  }
}

function getOrCreateDashboardList(type, name, icon = '📋') {
  const allLists = getLists();
  const matchingNameAndType = allLists.filter(l => l.type === type && (l.name || '').toLowerCase() === (name || '').toLowerCase());
  if (matchingNameAndType.length > 0) {
    matchingNameAndType.sort((a, b) => ((b.items || []).filter(i => Number(i.checked) !== 1).length) - ((a.items || []).filter(i => Number(i.checked) !== 1).length));
    return matchingNameAndType[0];
  }

  const sameTypeLists = allLists.filter(l => l.type === type);
  if (sameTypeLists.length > 0) {
    sameTypeLists.sort((a, b) => ((b.items || []).filter(i => Number(i.checked) !== 1).length) - ((a.items || []).filter(i => Number(i.checked) !== 1).length));
    return sameTypeLists[0];
  }
  return insertList({ name, type, icon });
}

function findOrCreateTargetList(rawListName, defaultType = 'shopping') {
  const allLists = getLists();
  if (!rawListName || !String(rawListName).trim()) {
    return defaultType === 'tasks'
      ? getOrCreateDashboardList('tasks', 'Family Tasks', '✅')
      : getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
  }
  const cleanName = String(rawListName).trim();
  const lower = cleanName.toLowerCase();
  if (lower === 'shopping' || lower === 'shopping list' || lower === 'groceries') {
    return getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
  }
  if (lower === 'tasks' || lower === 'family tasks' || lower === 'chores') {
    return getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
  }
  // Match ANY existing list (including custom lists!) by exact or partial name
  const exact = allLists.find(l => (l.name || '').toLowerCase() === lower);
  if (exact) return exact;
  const partial = allLists.find(l => (l.name || '').toLowerCase().includes(lower) || lower.includes((l.name || '').toLowerCase()));
  if (partial) return partial;
  // Create a custom list (or shopping if explicitly named)
  const inferredType = /shop|grocer|market|store/i.test(cleanName) ? 'shopping' : 'custom';
  const inferredIcon = inferredType === 'shopping' ? '🛒' : '📋';
  return insertList({ name: cleanName, type: inferredType, icon: inferredIcon });
}

function resolveProfileIdFromName(rawName, senderProfile) {
  if (!rawName) return senderProfile ? senderProfile.id : null;
  const normalized = String(rawName).trim().toLowerCase();
  if (!normalized) return senderProfile ? senderProfile.id : null;
  if (normalized === 'me' || normalized === 'myself') return senderProfile ? senderProfile.id : null;
  if (['family', 'all', 'everyone', 'entire family', 'whole family', 'everybody'].includes(normalized)) return null;

  const profiles = getProfiles();
  const exactMatch = profiles.find((profile) => (profile.name || '').toLowerCase() === normalized);
  if (exactMatch) return exactMatch.id;

  const partialMatch = profiles.find((profile) => (profile.name || '').toLowerCase().includes(normalized));
  return partialMatch ? partialMatch.id : null;
}

function normalizeDateString(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value.toLowerCase() === 'today') return new Date().toISOString().slice(0, 10);
  if (value.toLowerCase() === 'tomorrow') {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return date.toISOString().slice(0, 10);
  }
  return null;
}

function normalizeDayOfWeek(dayStr) {
  if (!dayStr) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return names[new Date().getDay()];
  }
  const s = String(dayStr).trim().toLowerCase();
  if (s === 'today') {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return names[new Date().getDay()];
  }
  if (s === 'tomorrow') {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return names[(new Date().getDay() + 1) % 7];
  }
  const map = {
    mon: 'Monday', monday: 'Monday',
    tue: 'Tuesday', tuesday: 'Tuesday',
    wed: 'Wednesday', wednesday: 'Wednesday',
    thu: 'Thursday', thursday: 'Thursday',
    fri: 'Friday', friday: 'Friday',
    sat: 'Saturday', saturday: 'Saturday',
    sun: 'Sunday', sunday: 'Sunday'
  };
  return map[s] || (s.charAt(0).toUpperCase() + s.slice(1));
}

function generateFutureCalendarDates(startDateStr, recurrence, interval = 1, maxCount = 8) {
  const dates = [];
  const base = new Date(startDateStr);
  if (isNaN(base.getTime())) return dates;

  const cleanRec = String(recurrence || '').toLowerCase();
  const step = Math.max(1, Number(interval) || 1);

  for (let i = 1; i <= maxCount; i++) {
    const next = new Date(base);
    if (cleanRec === 'daily') {
      next.setDate(next.getDate() + (step * i));
    } else if (cleanRec === 'weekly') {
      next.setDate(next.getDate() + (7 * step * i));
    } else if (cleanRec === 'weekdays') {
      let added = 0;
      let checkDate = new Date(base);
      while (added < (step * i)) {
        checkDate.setDate(checkDate.getDate() + 1);
        const day = checkDate.getDay();
        if (day !== 0 && day !== 6) added++;
      }
      next.setTime(checkDate.getTime());
    } else if (cleanRec === 'monthly') {
      next.setMonth(next.getMonth() + (step * i));
    } else {
      break;
    }
    dates.push(next.toISOString().slice(0, 10));
  }
  return dates;
}

// Helper: execute all actions returned by Gemini
async function applyParsedGeminiActions(parsedData, senderProfile, ioInstance = null) {
  const { notes, tasks, shopping_items, calendar_events, meal_actions, timer } = parsedData || {};
  const senderName = senderProfile ? senderProfile.name : null;
  const actionsSummary = [];

  if (Array.isArray(notes) && notes.length > 0) {
    let addedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;
    const allNotes = getNotes(100);
    for (const note of notes) {
      if (typeof note === 'string') {
        const content = senderName ? `[${senderName}]: ${note}` : note;
        insertNote(content);
        addedCount++;
      } else if (note && typeof note === 'object') {
        const action = String(note.action || 'add').toLowerCase();
        const target = note.id
          ? allNotes.find(n => n.id === Number(note.id))
          : (note.match ? allNotes.find(n => (n.content || '').toLowerCase().includes(note.match.toLowerCase())) : null);
        if (action === 'delete' && target) {
          deleteNote(target.id);
          deletedCount++;
        } else if (action === 'edit' && target && note.content) {
          const content = senderName ? `[${senderName}]: ${note.content}` : note.content;
          updateNote(target.id, content);
          updatedCount++;
        } else if (note.content) {
          const content = senderName ? `[${senderName}]: ${note.content}` : note.content;
          insertNote(content);
          addedCount++;
        }
      }
    }
    if (addedCount) actionsSummary.push(`Added ${addedCount} note(s)`);
    if (updatedCount) actionsSummary.push(`Updated ${updatedCount} note(s)`);
    if (deletedCount) actionsSummary.push(`Deleted ${deletedCount} note(s)`);
  }

  if (Array.isArray(tasks) && tasks.length > 0) {
    const tasksList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
    let added = 0;
    let completed = 0;
    let edited = 0;
    let deleted = 0;
    for (const task of tasks) {
      const action = String(task.action || 'add').toLowerCase();
      const currentItems = getListById(tasksList.id)?.items || [];
      const searchStr = String(task.match || task.title || '').toLowerCase();
      const matchedItem = task.id
        ? currentItems.find(i => i.id === Number(task.id))
        : (searchStr ? currentItems.find(i => (i.content || '').toLowerCase().includes(searchStr)) : null);

      if ((action === 'complete' || action === 'done' || action === 'check') && matchedItem) {
        toggleListItemChecked(matchedItem.id, true, senderName || 'Telegram');
        completed++;
      } else if (action === 'delete' && matchedItem) {
        deleteListItem(matchedItem.id);
        deleted++;
      } else if (action === 'edit' && matchedItem) {
        updateListItem(matchedItem.id, {
          content: task.new_title || task.title || matchedItem.content,
          reward: task.reward !== undefined ? task.reward : matchedItem.reward,
          due_date: task.due_date ? (normalizeDateString(task.due_date) || task.due_date) : matchedItem.due_date,
          due_time: task.due_time !== undefined ? task.due_time : matchedItem.due_time
        });
        edited++;
      } else {
        const isFamily = !task.assignee || ['family', 'all', 'everyone', 'entire family', 'whole family'].includes(String(task.assignee).toLowerCase());
        const assigneeProfileId = isFamily ? null : resolveProfileIdFromName(task.assignee, senderProfile);

        insertListItem({
          list_id: tasksList.id,
          content: task.title,
          assignee_profile_id: assigneeProfileId,
          reward: Number(task.reward) || 0,
          due_date: normalizeDateString(task.due_date) || task.due_date || null,
          due_time: task.due_time || null,
          recurrence: task.recurrence || 'none',
          recurrence_interval: Number(task.recurrence_interval) || 1,
          recurrence_days: task.recurrence_days || null
        });
        insertTask({
          title: task.title,
          assignee: isFamily ? 'Family' : (task.assignee || senderName),
          reward: Number(task.reward) || 0
        });
        added++;
      }
    }
    if (added) actionsSummary.push(`Created ${added} task(s)`);
    if (completed) actionsSummary.push(`Completed ${completed} task(s)`);
    if (edited) actionsSummary.push(`Updated ${edited} task(s)`);
    if (deleted) actionsSummary.push(`Deleted ${deleted} task(s)`);
  }

  if (Array.isArray(shopping_items) && shopping_items.length > 0) {
    let added = 0;
    let checked = 0;
    let edited = 0;
    let deleted = 0;
    for (const item of shopping_items) {
      const targetList = findOrCreateTargetList(item.list_name, 'shopping');
      const action = String(item.action || 'add').toLowerCase();
      const listItems = getListById(targetList.id)?.items || [];
      const searchStr = String(item.content || '').toLowerCase();
      const matched = item.id
        ? listItems.find(i => i.id === Number(item.id))
        : (searchStr ? listItems.find(i => (i.content || '').toLowerCase() === searchStr || (i.content || '').toLowerCase().includes(searchStr)) : null);

      if ((action === 'check' || action === 'done' || action === 'complete') && matched) {
        toggleListItemChecked(matched.id, true, senderName || 'Telegram');
        checked++;
      } else if (action === 'uncheck' && matched) {
        toggleListItemChecked(matched.id, false, senderName || 'Telegram');
        edited++;
      } else if ((action === 'delete' || action === 'remove') && matched) {
        deleteListItem(matched.id);
        deleted++;
      } else if (action === 'edit' && matched) {
        updateListItem(matched.id, {
          content: item.new_content || item.content || matched.content
        });
        edited++;
      } else {
        const isFamily = !item.assignee || ['family', 'all', 'everyone', 'entire family', 'whole family'].includes(String(item.assignee).toLowerCase());
        const assigneeProfileId = isFamily ? null : resolveProfileIdFromName(item.assignee, senderProfile);

        insertListItem({
          list_id: targetList.id,
          content: item.content,
          assignee_profile_id: assigneeProfileId,
          reward: 0,
          recurrence: item.recurrence || 'none',
          recurrence_interval: Number(item.recurrence_interval) || 1
        });
        added++;
      }
    }
    if (added) actionsSummary.push(`Added ${added} shopping item(s)`);
    if (checked) actionsSummary.push(`Checked ${checked} list item(s)`);
    if (edited) actionsSummary.push(`Updated ${edited} list item(s)`);
    if (deleted) actionsSummary.push(`Removed ${deleted} list item(s)`);
  }

  if (Array.isArray(calendar_events) && calendar_events.length > 0) {
    let createdCount = 0;
    let deletedCount = 0;
    let updatedCount = 0;
    const existingEvents = getCalendarEvents({ limit: 250 });
    for (const ev of calendar_events) {
      const action = String(ev.action || 'add').toLowerCase();
      const matchedEv = ev.id
        ? existingEvents.find(e => e.id === Number(ev.id))
        : existingEvents.find(e => (e.title || '').toLowerCase().includes(String(ev.title || '').toLowerCase()));

      if ((action === 'delete' || action === 'remove') && matchedEv) {
        deleteCalendarEvent(matchedEv.id);
        deletedCount++;
        continue;
      }
      if (action === 'edit' && matchedEv) {
        const baseDate = normalizeDateString(ev.date) || ev.date || matchedEv.start_datetime.slice(0, 10);
        const startIso = ev.time ? `${baseDate}T${ev.time}:00` : matchedEv.start_datetime;
        updateCalendarEvent(matchedEv.id, {
          title: ev.new_title || ev.title || matchedEv.title,
          start_datetime: startIso,
          all_day: ev.all_day !== undefined ? ev.all_day : matchedEv.all_day
        });
        updatedCount++;
        continue;
      }

      const isFamily = !ev.person || ['family', 'all', 'everyone', 'entire family', 'whole family'].includes(String(ev.person).toLowerCase());
      let eventProfileId = isFamily ? null : resolveProfileIdFromName(ev.person, senderProfile);
      if (!isFamily && !eventProfileId && senderProfile) {
        eventProfileId = senderProfile.id;
      }
      let feedId = null;
      let eventColor = '#38bdf8';

      const feeds = getCalendarFeeds();
      if (ev.person) {
        const matchedFeed = feeds.find(f => (f.name || '').toLowerCase() === String(ev.person).toLowerCase())
          || feeds.find(f => (f.name || '').toLowerCase().includes(String(ev.person).toLowerCase()));
        if (matchedFeed) {
          feedId = matchedFeed.id;
          if (matchedFeed.color) eventColor = matchedFeed.color;
          if (matchedFeed.profile_id && !eventProfileId) eventProfileId = matchedFeed.profile_id;
        }
      }

      if (!feedId && eventProfileId) {
        const profileFeed = feeds.find(f => f.profile_id === eventProfileId);
        if (profileFeed) {
          feedId = profileFeed.id;
          if (profileFeed.color) eventColor = profileFeed.color;
        }
      }

      const baseDate = normalizeDateString(ev.date) || ev.date || new Date().toISOString().slice(0, 10);
      const startIso = ev.time ? `${baseDate}T${ev.time}:00` : `${baseDate}T09:00:00`;

      insertCalendarEvent({
        uid: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        feed_id: feedId,
        title: ev.title,
        start_datetime: startIso,
        all_day: ev.all_day ? 1 : 0,
        profile_id: eventProfileId,
        color: eventColor,
        source: 'telegram'
      });
      createdCount++;

      if (ev.recurrence && ev.recurrence !== 'none') {
        const futureDates = generateFutureCalendarDates(baseDate, ev.recurrence, ev.recurrence_interval, 8);
        for (const fDate of futureDates) {
          const recStartIso = ev.time ? `${fDate}T${ev.time}:00` : `${fDate}T09:00:00`;
          insertCalendarEvent({
            uid: `evt-rec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            feed_id: feedId,
            title: ev.title,
            start_datetime: recStartIso,
            all_day: ev.all_day ? 1 : 0,
            profile_id: eventProfileId,
            color: eventColor,
            source: 'telegram'
          });
          createdCount++;
        }
      }
    }
    if (createdCount) actionsSummary.push(`Scheduled ${createdCount} event(s)`);
    if (updatedCount) actionsSummary.push(`Updated ${updatedCount} event(s)`);
    if (deletedCount) actionsSummary.push(`Deleted ${deletedCount} event(s)`);
  }

  if (Array.isArray(meal_actions) && meal_actions.length > 0) {
    let mealCount = 0;
    const allDishes = getDishes();
    for (const ma of meal_actions) {
      let matchedDish = ma.dish_name
        ? allDishes.find(d => d.name.toLowerCase() === ma.dish_name.toLowerCase())
        : null;
      if (!matchedDish && ma.dish_name && (ma.action === 'add_dish' || (ma.ingredients && ma.ingredients.length > 0) || ma.recipe)) {
        matchedDish = insertDish({
          name: ma.dish_name,
          ingredients: ma.ingredients || [],
          recipe: ma.recipe || '',
          tags: ma.tags || []
        });
        allDishes.push(matchedDish);
      }
      if ((ma.action === 'set_meal' || ma.action === 'set_slot') && ma.dish_name) {
        const day = normalizeDayOfWeek(ma.day);
        const slot = ma.slot || 'Dinner';
        setMealSlotEntry({
          day,
          slot,
          entries: [{
            dish_id: matchedDish ? matchedDish.id : null,
            name: matchedDish ? matchedDish.name : ma.dish_name
          }]
        });
        mealCount++;
      } else if (ma.action === 'ingredients_to_shopping') {
        const shopList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
        const ings = (matchedDish && matchedDish.ingredients && matchedDish.ingredients.length)
          ? matchedDish.ingredients
          : (ma.ingredients || []);
        for (const ing of ings) {
          insertListItem({ list_id: shopList.id, content: ing });
        }
        mealCount++;
      } else if (ma.action === 'add_dish' && matchedDish) {
        mealCount++;
      }
    }
    if (mealCount) actionsSummary.push(`Processed ${mealCount} meal action(s)`);
  }

  if (timer && timer.minutes) {
    if (ioInstance) {
      ioInstance.emit('timer:set', { minutes: Number(timer.minutes), action: timer.action || 'start' });
    }
    actionsSummary.push(`Set timer for ${timer.minutes} min`);
  }

  const updatedData = getDashboardData();
  if (ioInstance) {
    ioInstance.emit('dashboard_update', updatedData);
  }
  return {
    updatedData,
    summary: actionsSummary.join(', ') || 'No actions taken'
  };
}

function buildConfirmationMessage(parsedData, senderProfile) {
  const { notes, tasks, shopping_items, calendar_events, meal_actions, timer, response_message } = parsedData || {};
  const greeting = senderProfile ? `👋 *Hi ${escapeMd(senderProfile.name)}!*` : `✅ *Smart Home Dashboard Updated!*`;
  let msg = `${greeting}\n`;

  if (response_message) {
    msg += `_${escapeMd(response_message)}_\n\n`;
  }

  if (tasks && tasks.length > 0) {
    msg += `📋 *Tasks:*\n` + tasks.map(t => {
      const act = t.action && t.action !== 'add' ? `[${t.action.toUpperCase()}] ` : '';
      const who = t.assignee ? `(@${escapeMd(t.assignee)}) ` : '(Family) ';
      const rew = t.reward ? ` [+${t.reward}]` : '';
      const rec = t.recurrence && t.recurrence !== 'none' ? ` [🔁 ${t.recurrence}]` : '';
      return `• ${act}${escapeMd(t.new_title || t.title)} ${who}${rew}${rec}`;
    }).join('\n') + '\n';
  }

  if (shopping_items && shopping_items.length > 0) {
    msg += `🛒 *Lists updated:*\n` + shopping_items.map(s => {
      const act = s.action && s.action !== 'add' ? `[${s.action.toUpperCase()}] ` : '';
      const listTag = s.list_name ? `[${escapeMd(s.list_name)}] ` : '';
      const who = s.assignee ? `(@${escapeMd(s.assignee)}) ` : '';
      const rec = s.recurrence && s.recurrence !== 'none' ? ` [🔁 ${s.recurrence}]` : '';
      return `• ${act}${listTag}${escapeMd(s.new_content || s.content)} ${who}${rec}`.trim();
    }).join('\n') + '\n';
  }

  if (calendar_events && calendar_events.length > 0) {
    msg += `📅 *Calendar events:*\n` + calendar_events.map(e => {
      const act = e.action && e.action !== 'add' ? `[${e.action.toUpperCase()}] ` : '';
      const who = e.person ? `(@${escapeMd(e.person)}) ` : '(Family) ';
      const rec = e.recurrence && e.recurrence !== 'none' ? ` [🔁 ${e.recurrence}]` : '';
      return `• ${act}${escapeMd(e.new_title || e.title)} ${who}(${escapeMd(e.date || 'today')} ${escapeMd(e.time || '')})${rec}`;
    }).join('\n') + '\n';
  }

  if (meal_actions && meal_actions.length > 0) {
    msg += `🍽️ *Menu of the Week:*\n` + meal_actions.map(m => {
      if (m.action === 'set_meal') return `• ${m.day || 'Today'} ${m.slot || 'Meal'}: *${escapeMd(m.dish_name)}*`;
      if (m.action === 'add_dish') return `• Added dish: *${escapeMd(m.dish_name)}*`;
      return `• Added ingredients for *${escapeMd(m.dish_name || 'menu')}* to Shopping List`;
    }).join('\n') + '\n';
  }

  if (notes && notes.length > 0) {
    msg += `📝 *Notes:*\n` + notes.map(n => {
      if (typeof n === 'string') return `• ${escapeMd(n)}`;
      return `• [${(n.action || 'add').toUpperCase()}] ${escapeMd(n.content || n.match || `#${n.id}`)}`;
    }).join('\n') + '\n';
  }

  if (timer && timer.minutes) {
    msg += `⏳ *Kitchen Timer:* Set for ${timer.minutes} minutes!\n`;
  }

  if (!tasks?.length && !shopping_items?.length && !calendar_events?.length && !notes?.length && !meal_actions?.length && !timer) {
    if (!response_message) {
      msg += `_(No specific actions detected)_`;
    }
  }

  return msg.trim();
}

function buildMainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🛒 Shopping List', 'menu:list:shopping'),
      Markup.button.callback('✅ Tasks', 'menu:list:tasks')
    ],
    [
      Markup.button.callback('📋 All Lists', 'menu:lists_all'),
      Markup.button.callback('🍽️ Meal Menu', 'menu:meals:today')
    ],
    [
      Markup.button.callback('📝 Notes', 'menu:notes'),
      Markup.button.callback('📅 Today & Events', 'menu:today')
    ],
    [
      Markup.button.callback('🍲 Dish Catalog', 'menu:dishes'),
      Markup.button.callback('⭐ Rewards Store', 'menu:rewards')
    ],
    [
      Markup.button.callback('📊 Status', 'menu:status')
    ]
  ]);
}

function buildRewardsMessage(senderProfile = null) {
  const profiles = getProfiles();
  const rewards = getRewards();
  const activeProfile = senderProfile || profiles[0] || null;

  let text = `⭐ *Family Rewards Store*\n\n`;
  if (profiles.length > 0) {
    text += `*Points Balance:*\n`;
    for (const p of profiles) {
      const marker = activeProfile && p.id === activeProfile.id ? '👉 ' : '• ';
      text += `${marker}${p.avatar_value || '🙂'} *${p.name}:* ${Number(p.points_balance) || 0} ⭐\n`;
    }
    text += `\n`;
  }

  const buttons = [];
  if (rewards.length === 0) {
    text += `_No rewards configured yet._\n`;
  } else {
    text += `*Available Rewards:*\n`;
    for (const r of rewards) {
      text += `• ${r.icon || '🎁'} *${r.title}* — *${r.cost} ⭐*\n`;
      if (activeProfile) {
        buttons.push([
          Markup.button.callback(
            `${r.icon || '🎁'} Redeem "${r.title}" (${r.cost} ⭐ as ${activeProfile.name})`,
            `reward:redeem:${r.id}:${activeProfile.id}`
          )
        ]);
      }
    }
  }

  buttons.push([Markup.button.callback('🏠 Main Menu', 'menu:home')]);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

function buildListKeyboardAndText(listOrId, showHistory = false) {
  const allLists = getLists();
  const list = (listOrId && typeof listOrId === 'object') ? listOrId : allLists.find(l => l.id === Number(listOrId));
  if (!list) {
    return {
      text: '❌ List not found.',
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'menu:home')]])
    };
  }
  const allItems = Array.isArray(list.items) ? list.items : [];
  const activeItems = allItems.filter(i => Number(i.checked) !== 1);
  const completedItems = allItems.filter(i => Number(i.checked) === 1);

  let text = `${list.icon || '📋'} *${escapeMd(list.name)}*\n`;
  const buttons = [];

  if (!showHistory) {
    text += `_Active items: ${activeItems.length} • Resolved: ${completedItems.length}_\n\n`;
    if (activeItems.length === 0) {
      text += `🎉 No active items in this list!\n`;
    } else {
      const displayedItems = activeItems.slice(0, 15);
      for (const item of displayedItems) {
        const who = item.assignee_name ? ` (@${escapeMd(item.assignee_name)})` : '';
        const due = item.due_date ? ` • 📅 ${escapeMd(item.due_date)}` : '';
        const pts = item.reward ? ` • ⭐+${item.reward}pts` : '';
        const cat = item.category && list.type === 'shopping' ? ` • 🏷️ ${escapeMd(item.category)}` : '';
        text += `⬜ *#${item.id}* ${escapeMd(item.content)}${cat}${who}${due}${pts}\n`;
        const btnLabel = `✅ ${item.content}`.slice(0, 26);
        buttons.push([
          Markup.button.callback(btnLabel, `item:toggle:${item.id}:1`),
          Markup.button.callback('🗑️', `item:del:${item.id}:${list.id}`)
        ]);
      }
      if (activeItems.length > 15) {
        text += `\n_...and ${activeItems.length - 15} more active items._\n`;
      }
    }

    const navRow = [
      Markup.button.callback(`📜 History (${completedItems.length})`, `menu:list_resolved:${list.id}`)
    ];
    if (completedItems.length > 0) {
      navRow.push(Markup.button.callback('🧹 Clear Done', `list:clear:${list.id}`));
    }
    buttons.push(navRow);
  } else {
    text += `📜 *Resolved / Completed History (${completedItems.length}):*\n\n`;
    if (completedItems.length === 0) {
      text += `_No completed items yet._\n`;
    } else {
      const displayedDone = completedItems.slice(0, 15);
      for (const item of displayedDone) {
        const when = item.last_completed_at ? item.last_completed_at.slice(0, 16).replace('T', ' ') : '';
        const by = item.completed_by ? ` by *${escapeMd(item.completed_by)}*` : '';
        text += `✓ *#${item.id}* ${escapeMd(item.content)}${by}${when ? ` (${escapeMd(when)})` : ''}\n`;
        const btnLabel = `↩️ ${item.content}`.slice(0, 24);
        buttons.push([
          Markup.button.callback(btnLabel, `item:toggle:${item.id}:0`),
          Markup.button.callback('🗑️', `item:del:${item.id}:${list.id}`)
        ]);
      }
      if (completedItems.length > 15) {
        text += `\n_...and ${completedItems.length - 15} more completed items._\n`;
      }
    }
    buttons.push([
      Markup.button.callback(`⬅️ Back to Active (${activeItems.length})`, `menu:list_id:${list.id}`),
      ...(completedItems.length > 0 ? [Markup.button.callback('🧹 Clear All Done', `list:clear:${list.id}`)] : [])
    ]);
  }

  // Sibling lists switcher buttons (e.g. other shopping lists or other task lists that have active items)
  const siblingLists = allLists.filter(l => l.id !== list.id && l.type === list.type && (l.items || []).some(i => Number(i.checked) !== 1));
  if (siblingLists.length > 0) {
    const sibButtons = siblingLists.slice(0, 2).map(sl => {
      const cnt = (sl.items || []).filter(i => Number(i.checked) !== 1).length;
      return Markup.button.callback(`${sl.icon || '📋'} ${sl.name} (${cnt})`, `menu:list_id:${sl.id}`);
    });
    buttons.push(sibButtons);
  }

  buttons.push([
    Markup.button.callback('📋 All Lists', 'menu:lists_all'),
    Markup.button.callback('🏠 Main Menu', 'menu:home')
  ]);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

function detectListQueryIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim().toLowerCase();

  // Shopping query: "shopping list", "show shopping", "what's on the shopping list", "list shopping", "groceries", "покупки", "список покупок", "купить что надо"
  if (/^(?:show\s+|view\s+|list\s+|open\s+|what(?:'s|\s+is)\s+(?:in|on)\s+(?:the\s+|my\s+)?|get\s+)?(?:shopping|groceries|grocery)(?:\s+list)?\??$/i.test(clean) ||
      /(?:покажи|показать|что\s+в|какой|список)\s+(?:списк[еау]\s+|список\s+)?покуп(?:ок|ки|ках)?/i.test(clean) ||
      /^(?:покупки|список\s+покупок|що\s+купити|список\s+покупок)\??$/i.test(clean)) {
    return { type: 'shopping' };
  }

  // Tasks query: "tasks", "show tasks", "what are my tasks", "list tasks", "to do", "chores", "задачи", "список задач", "что сделать", "завдання"
  if (/^(?:show\s+|view\s+|list\s+|open\s+|what(?:'s|\s+are)\s+(?:the\s+|my\s+)?|get\s+)?(?:tasks?|to-?dos?|chores?)(?:\s+list)?\??$/i.test(clean) ||
      /(?:покажи|показать|что\s+в|какие|список)\s+(?:списк[еау]\s+|список\s+)?задач/i.test(clean) ||
      /^(?:задачи|список\s+задач|дела|список\s+дел|завдання)\??$/i.test(clean)) {
    return { type: 'tasks' };
  }

  // All lists query: "lists", "all lists", "show lists", "списки", "все списки"
  if (/^(?:show\s+|view\s+|list\s+|open\s+|what\s+are\s+)?(?:all\s+)?lists\??$/i.test(clean) ||
      /^(?:списки|все\s+списки|всі\s+списки)\??$/i.test(clean)) {
    return { type: 'all' };
  }

  // Specific list by name: e.g. "show Packing list", "list Hardware Store"
  const showMatch = clean.match(/^(?:show|view|list|open)\s+(?:the\s+)?(.+?)(?:\s+list)?\??$/i);
  if (showMatch && showMatch[1]) {
    const listQuery = showMatch[1].trim();
    if (!['notes', 'menu', 'today', 'status', 'help', 'events', 'photos', 'dishes', 'rewards'].includes(listQuery)) {
      return { type: 'named', name: listQuery };
    }
  }

  return null;
}

function buildMealMenuMessage(mode = 'today') {
  const menu = getActiveMealMenu();
  const dishesById = Object.fromEntries(getDishes().map(d => [String(d.id), d]));
  if (!menu) {
    return {
      text: `🍽️ *Menu of the Week*\n\n_No active weekly menu configured yet._`,
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'menu:home')]])
    };
  }

  const slots = Array.isArray(menu.meal_slots) && menu.meal_slots.length ? menu.meal_slots : getDefaultMealSlots();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const now = new Date();
  const todayName = dayNames[now.getDay()];
  const tomorrowName = dayNames[(now.getDay() + 1) % 7];

  let text = `🍽️ *${menu.name}*\n`;
  const daysToShow = mode === 'week' ? weekOrder : (mode === 'tomorrow' ? [tomorrowName] : [todayName]);

  for (const day of daysToShow) {
    text += `\n📅 *${day}${day === todayName ? ' (Today)' : (day === tomorrowName ? ' (Tomorrow)' : '')}:*\n`;
    const dayObj = (menu.schedule && menu.schedule[day]) || {};
    let hasAny = false;
    for (const slot of slots) {
      const entries = Array.isArray(dayObj[slot]) ? dayObj[slot] : [];
      if (entries.length > 0) {
        hasAny = true;
        const names = entries.map(e => {
          const d = e.dish_id ? dishesById[String(e.dish_id)] : null;
          return d ? d.name : (e.name || 'Dish');
        }).join(', ');
        text += `  • *${slot}:* ${names}\n`;
      } else if (mode !== 'week') {
        text += `  • *${slot}:* _—_\n`;
      }
    }
    if (!hasAny && mode === 'week') {
      text += `  _No meals planned_\n`;
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(mode === 'today' ? '🔘 Today' : 'Today', 'menu:meals:today'),
      Markup.button.callback(mode === 'tomorrow' ? '🔘 Tomorrow' : 'Tomorrow', 'menu:meals:tomorrow'),
      Markup.button.callback(mode === 'week' ? '🔘 Full Week' : 'Full Week', 'menu:meals:week')
    ],
    [
      Markup.button.callback('🛒 Add Week Ingredients to Shopping', `meals:shop:${menu.id}`),
      Markup.button.callback('🍲 Dishes', 'menu:dishes')
    ],
    [Markup.button.callback('🏠 Main Menu', 'menu:home')]
  ]);

  return { text, keyboard };
}

/**
 * Creates and configures the Telegraf bot instance.
 * @param {import('socket.io').Server} io - Socket.IO server instance
 */
function initBot(io) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN is not configured in .env. Bot polling inactive.');
    return null;
  }

  const bot = new Telegraf(token);

  // Register Telegram Bot Command Menu
  bot.telegram.setMyCommands([
    { command: 'menu', description: '🏠 Open interactive dashboard menu' },
    { command: 'shopping', description: '🛒 View & check off shopping list' },
    { command: 'tasks', description: '✅ View & complete family tasks' },
    { command: 'lists', description: '📋 View all custom lists' },
    { command: 'mealmenu', description: '🍽️ View Menu of the Week (meals)' },
    { command: 'dishes', description: '🍲 Browse dish catalog & recipes' },
    { command: 'rewards', description: '⭐ View points balance & redeem rewards' },
    { command: 'notes', description: '📝 View, edit, or delete notes' },
    { command: 'today', description: '📅 Today’s events & tasks' },
    { command: 'status', description: '📊 Dashboard snapshot' },
    { command: 'help', description: '❓ Show all commands & examples' }
  ]).catch((err) => console.warn('[Telegram] setMyCommands warning:', err.message));

  // Parse whitelist IDs from environment
  const getWhitelist = () => {
    return (process.env.TELEGRAM_WHITELIST_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  };

  // Middleware to strictly block any sender ID not in TELEGRAM_WHITELIST_IDS
  bot.use(async (ctx, next) => {
    const senderId = String(ctx.from?.id);
    const whitelist = getWhitelist();

    if (whitelist.length > 0 && !whitelist.includes(senderId)) {
      console.warn(`[Telegram] Blocked unauthorized message from ID: ${senderId} (@${ctx.from?.username || 'unknown'})`);
      insertAuditLog({
        source: 'telegram',
        sender_id: senderId,
        sender_name: ctx.from?.username || ctx.from?.first_name || 'unknown',
        message_type: ctx.message?.text ? 'text' : (ctx.message?.voice ? 'voice' : (ctx.message?.photo ? 'photo' : 'other')),
        raw_input: ctx.message?.text || ctx.message?.caption || null,
        action_taken: 'Blocked by TELEGRAM_WHITELIST_IDS',
        status: 'blocked',
        error_message: `Sender ${senderId} not in whitelist`
      });
      return;
    }

    return next();
  });

  // Command: /start, /help, /menu
  bot.command(['start', 'help', 'menu'], async (ctx) => {
    const msg =
      `👋 *Welcome to your Smart Home Dashboard Bot!*\n\n` +
      `Use the interactive buttons below, or send any natural-language message (text or voice) and Gemini AI will manage your lists, tasks, notes, calendar, or weekly meal menu.\n\n` +
      `*Quick Commands:*\n` +
      `• /menu — Interactive dashboard menu\n` +
      `• /shopping — Interactive shopping list\n` +
      `• /tasks — Interactive tasks & chores\n` +
      `• /lists — View all custom lists\n` +
      `• /list <name> — Open a specific custom list\n` +
      `• /addlist <List> | <Item> — Add item to custom list\n` +
      `• /mealmenu — View Menu of the Week\n` +
      `• /dishes — Browse dish catalog & tags\n` +
      `• /setmeal <Day> <Slot> <Dish> — Set a meal\n` +
      `• /rewards — View points balance & redeem rewards\n` +
      `• /notes — View & manage notes\n` +
      `• /addnote <text> | /editnote <id> <text> | /delnote <id>\n` +
      `• /check <id> | /uncheck <id> | /edititem <id> <text> | /delitem <id>\n` +
      `• /today — Today's schedule & tasks\n` +
      `• /event <YYYY-MM-DD> <HH:MM> <title> | /delevent <id>\n` +
      `• /timer <minutes> — Start kitchen timer`;
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/menu',
      action_taken: 'Displayed interactive main menu',
      status: 'success'
    });
    await safeReplyMarkdown(ctx, msg, buildMainMenuKeyboard());
  });

  bot.command('rewards', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const { text, keyboard } = buildRewardsMessage(senderProfile);
    await safeReplyMarkdown(ctx, text, keyboard);
  });

  bot.command('status', async (ctx) => {
    const tasksList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
    const shoppingList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
    const notes = getNotes(5);
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayEvents = getCalendarEvents({ limit: 20 }).filter(e => e.start_datetime && e.start_datetime.startsWith(todayStr));

    const taskCount = (tasksList.items || []).filter(item => item.checked !== 1).length;
    const shoppingCount = (shoppingList.items || []).filter(item => item.checked !== 1).length;

    const reply = `📊 *Dashboard Snapshot*\n\n` +
      `• Tasks pending: ${taskCount}\n` +
      `• Shopping pending: ${shoppingCount}\n` +
      `• Notes today: ${notes.length}\n` +
      `• Events today: ${todayEvents.length}\n\n` +
      `Use /tasks, /shopping, /notes, or just send a normal message to Gemini.`;
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/status',
      action_taken: `Reported status: ${taskCount} tasks, ${shoppingCount} shopping, ${notes.length} notes, ${todayEvents.length} events`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, reply);
  });

  bot.command('tasks', async (ctx) => {
    const taskList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
    const items = Array.isArray(taskList.items) ? taskList.items : [];
    const { text, keyboard } = buildListKeyboardAndText(taskList.id, false);
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/tasks',
      action_taken: `Listed ${items.length} tasks`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, text, keyboard);
  });

  bot.command('shopping', async (ctx) => {
    const shoppingList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
    const items = Array.isArray(shoppingList.items) ? shoppingList.items : [];
    const { text, keyboard } = buildListKeyboardAndText(shoppingList.id, false);
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/shopping',
      action_taken: `Listed ${items.length} shopping items`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, text, keyboard);
  });

  bot.command('lists', async (ctx) => {
    const allLists = getLists();
    let reply = `📋 *All Dashboard Lists (${allLists.length}):*\n\n`;
    const buttons = [];
    for (const l of allLists) {
      const activeCount = (l.items || []).filter(i => Number(i.checked) !== 1).length;
      const doneCount = (l.items || []).filter(i => Number(i.checked) === 1).length;
      reply += `• ${l.icon || '📋'} *${escapeMd(l.name)}* — ${activeCount} active, ${doneCount} completed\n`;
      buttons.push([Markup.button.callback(`${l.icon || '📋'} ${l.name} (${activeCount})`, `menu:list_id:${l.id}`)]);
    }
    reply += `\n_Use /list <name> or tap a button below to open a list, or /addlist <List> | <Item> to add an item._`;
    buttons.push([Markup.button.callback('🏠 Main Menu', 'menu:home')]);
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/lists',
      action_taken: `Listed ${allLists.length} lists`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, reply, Markup.inlineKeyboard(buttons));
  });

  bot.command('list', async (ctx) => {
    const nameQuery = ctx.message.text.replace(/^\/list\s*/i, '').trim();
    if (!nameQuery) {
      return ctx.reply('Usage: /list <list name>  e.g. /list Packing List');
    }
    const allLists = getLists();
    const match = allLists.find(l => (l.name || '').toLowerCase().includes(nameQuery.toLowerCase()));
    if (!match) {
      return ctx.reply(`❌ List matching "${nameQuery}" not found. Use /lists to see all lists or /addlist ${nameQuery} | <item> to create it.`);
    }
    const { text, keyboard } = buildListKeyboardAndText(match.id, false);
    await safeReplyMarkdown(ctx, text, keyboard);
  });

  bot.command('addlist', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/addlist\s*/i, '').trim();
    if (!raw || !raw.includes('|')) {
      return ctx.reply('Usage: /addlist <List Name> | <Item Content>\nExample: /addlist Hardware Store | AA Batteries');
    }
    const [listPart, ...itemParts] = raw.split('|');
    const listName = listPart.trim();
    const itemContent = itemParts.join('|').trim();
    if (!listName || !itemContent) {
      return ctx.reply('Usage: /addlist <List Name> | <Item Content>');
    }
    const targetList = findOrCreateTargetList(listName, 'shopping');
    const item = insertListItem({ list_id: targetList.id, content: itemContent });
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Added "${itemContent}" (#${item.id}) to list "${targetList.name}"`,
      status: 'success'
    });
    const { text, keyboard } = buildListKeyboardAndText(targetList.id, false);
    await safeReplyMarkdown(ctx, `✅ Added *${escapeMd(itemContent)}* to *${escapeMd(targetList.name)}*!\n\n${text}`, keyboard);
  });

  bot.command('notes', async (ctx) => {
    const notes = getNotes(15);
    if (notes.length === 0) {
      insertAuditLog({
        source: 'telegram_command',
        sender_id: String(ctx.from?.id),
        sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
        message_type: 'command',
        raw_input: ctx.message?.text || '/notes',
        action_taken: 'Listed notes (empty)',
        status: 'success'
      });
      return ctx.reply('📝 No notes recorded yet. Use /addnote <text> to create one.');
    }

    let reply = `📝 *Recent Notes (${notes.length}):*\n\n`;
    const buttons = [];
    for (const n of notes) {
      reply += `• *#${n.id}:* ${escapeMd(n.content)}\n`;
      buttons.push([
        Markup.button.callback(`🗑️ Delete #${n.id}: ${n.content.slice(0, 22)}`, `note:del:${n.id}`)
      ]);
    }
    reply += `\n_Tip: /editnote <id> <new text> or /delnote <id>_`;
    buttons.push([Markup.button.callback('🏠 Main Menu', 'menu:home')]);
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/notes',
      action_taken: `Listed ${notes.length} notes`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, reply, Markup.inlineKeyboard(buttons));
  });

  bot.command('editnote', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/editnote\s*/i, '').trim();
    const match = raw.match(/^#?(\d+)\s+(.+)$/);
    if (!match) {
      return ctx.reply('Usage: /editnote <id> <new text>\nExample: /editnote 2 Updated alarm code');
    }
    const noteId = Number(match[1]);
    const newText = match[2].trim();
    const updated = updateNote(noteId, newText);
    if (!updated) return ctx.reply(`❌ Note #${noteId} not found.`);
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Edited note #${noteId}: "${newText}"`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, `✏️ *Note #${noteId} updated:*\n\n_${escapeMd(updated.content)}_`);
  });

  bot.command('delnote', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/delnote\s*/i, '').trim().replace(/^#/, '');
    const noteId = Number(raw);
    if (!noteId) return ctx.reply('Usage: /delnote <id>');
    deleteNote(noteId);
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Deleted note #${noteId}`,
      status: 'success'
    });
    await ctx.reply(`🗑️ Note #${noteId} deleted.`);
  });

  bot.command('check', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/check\s*/i, '').trim().replace(/^#/, '');
    const itemId = Number(raw);
    if (!itemId) return ctx.reply('Usage: /check <item_id>');
    const updated = toggleListItemChecked(itemId, true, senderName);
    if (!updated) return ctx.reply(`❌ Item #${itemId} not found.`);
    io.emit('dashboard_update', getDashboardData());
    await ctx.reply(`✅ Item #${itemId} "${updated.content}" checked off by ${senderName}!`);
  });

  bot.command('uncheck', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/uncheck\s*/i, '').trim().replace(/^#/, '');
    const itemId = Number(raw);
    if (!itemId) return ctx.reply('Usage: /uncheck <item_id>');
    const updated = toggleListItemChecked(itemId, false, senderName);
    if (!updated) return ctx.reply(`❌ Item #${itemId} not found.`);
    io.emit('dashboard_update', getDashboardData());
    await ctx.reply(`↩️ Item #${itemId} "${updated.content}" restored to active list.`);
  });

  bot.command('edititem', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/edititem\s*/i, '').trim();
    const match = raw.match(/^#?(\d+)\s+(.+)$/);
    if (!match) return ctx.reply('Usage: /edititem <id> <new text>');
    const itemId = Number(match[1]);
    const newText = match[2].trim();
    const updated = updateListItem(itemId, { content: newText });
    if (!updated) return ctx.reply(`❌ Item #${itemId} not found.`);
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Edited item #${itemId} to "${newText}"`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, `✏️ *Item #${itemId} updated:* ${escapeMd(updated.content)}`);
  });

  bot.command('delitem', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/delitem\s*/i, '').trim().replace(/^#/, '');
    const itemId = Number(raw);
    if (!itemId) return ctx.reply('Usage: /delitem <id>');
    deleteListItem(itemId);
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Deleted list item #${itemId}`,
      status: 'success'
    });
    await ctx.reply(`🗑️ Item #${itemId} deleted.`);
  });

  bot.command('delevent', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/delevent\s*/i, '').trim().replace(/^#/, '');
    const eventId = Number(raw);
    if (!eventId) return ctx.reply('Usage: /delevent <id>');
    deleteCalendarEvent(eventId);
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Deleted calendar event #${eventId}`,
      status: 'success'
    });
    await ctx.reply(`🗑️ Calendar event #${eventId} deleted.`);
  });

  bot.command('mealmenu', async (ctx) => {
    const modeArg = ctx.message.text.replace(/^\/mealmenu\s*/i, '').trim().toLowerCase();
    const mode = ['today', 'tomorrow', 'week'].includes(modeArg) ? modeArg : 'today';
    const { text, keyboard } = buildMealMenuMessage(mode);
    await safeReplyMarkdown(ctx, text, keyboard);
  });

  bot.command('dishes', async (ctx) => {
    const tagFilter = ctx.message.text.replace(/^\/dishes\s*/i, '').trim();
    const dishes = getDishes({ tag: tagFilter || undefined });
    if (dishes.length === 0) {
      return ctx.reply(tagFilter ? `🍲 No dishes found with tag "${tagFilter}".` : '🍲 No dishes in catalog yet.');
    }
    let reply = `🍲 *Dish Catalog${tagFilter ? ` (${escapeMd(tagFilter)})` : ''} (${dishes.length}):*\n\n`;
    const buttons = [];
    for (const d of dishes.slice(0, 15)) {
      const tags = (d.tags || []).length ? ` _[${escapeMd(d.tags.join(', '))}]_` : '';
      reply += `• *#${d.id} ${escapeMd(d.name)}*${tags}\n`;
      buttons.push([
        Markup.button.callback(`📖 ${d.name}`, `dish:view:${d.id}`),
        Markup.button.callback(`🛒 Ingredients`, `dish:shop:${d.id}`)
      ]);
    }
    buttons.push([Markup.button.callback('🍽️ Back to Meal Menu', 'menu:meals:today')]);
    await safeReplyMarkdown(ctx, reply, Markup.inlineKeyboard(buttons));
  });

  bot.command('setmeal', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const raw = ctx.message.text.replace(/^\/setmeal\s*/i, '').trim();
    const parts = raw.split(/\s+/);
    if (parts.length < 3) {
      return ctx.reply('Usage: /setmeal <Day> <Slot> <Dish Name>\nExample: /setmeal Monday Dinner Spaghetti Bolognese');
    }
    const dayInput = parts[0];
    const slotInput = parts[1];
    const dishName = parts.slice(2).join(' ');
    const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const day = weekDays.find(d => d.toLowerCase().startsWith(dayInput.toLowerCase())) || dayInput;
    const activeMenu = getActiveMealMenu();
    if (!activeMenu) return ctx.reply('❌ No active meal menu found.');
    const slots = activeMenu.meal_slots || getDefaultMealSlots();
    const slot = slots.find(s => s.toLowerCase() === slotInput.toLowerCase()) || slotInput;

    let dish = getDishes().find(d => d.name.toLowerCase() === dishName.toLowerCase());
    if (!dish) {
      dish = insertDish({ name: dishName, tags: [slot.toLowerCase()] });
    }
    setMealSlotEntry(activeMenu.id, day, slot, [{ dish_id: dish.id, name: dish.name }]);
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Set ${day} ${slot} to "${dish.name}"`,
      status: 'success'
    });
    const { text, keyboard } = buildMealMenuMessage('week');
    await safeReplyMarkdown(ctx, `✅ Set *${escapeMd(day)} — ${escapeMd(slot)}* to *${escapeMd(dish.name)}*!\n\n${text}`, keyboard);
  });

  bot.command('addnote', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const text = ctx.message.text.replace(/^\/addnote\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /addnote <text>');
    const note = insertNote(text);
    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Saved note #${note.id}: "${note.content}"`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, `✅ *Note saved:*\n\n_${escapeMd(note.content)}_`);
  });

  bot.command('addtask', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const text = ctx.message.text.replace(/^\/addtask\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /addtask <title> [reward] [assignee]');

    const tokens = text.split(/\s+/);
    const reward = Number(tokens.find((token) => /^\+?\d+$/.test(token)) || 0) || 0;
    const assignee = tokens.find((token) => token.startsWith('@')) ? tokens.find((token) => token.startsWith('@')).replace('@', '') : null;
    const titleTokens = tokens.filter((token) => !(/^\+?\d+$/.test(token)) && !token.startsWith('@'));
    const title = titleTokens.join(' ');

    const tasksList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
    const item = insertListItem({
      list_id: tasksList.id,
      content: title.trim(),
      assignee_profile_id: resolveProfileIdFromName(assignee || (senderProfile ? senderProfile.name : null), senderProfile),
      reward,
      due_date: new Date().toISOString().slice(0, 10)
    });

    insertTask({
      assignee: assignee || (senderProfile ? senderProfile.name : null),
      title: title.trim(),
      reward
    });

    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Created task #${item.id} "${title.trim()}" (reward: ${reward})`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, `✅ *Task added:*\n\n• #${item.id} ${escapeMd(title.trim())}${reward ? ` [+${reward} pts]` : ''}`);
  });

  bot.command('addshopping', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const text = ctx.message.text.replace(/^\/addshopping\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /addshopping <item>');

    const shoppingList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
    const item = insertListItem({
      list_id: shoppingList.id,
      content: text
    });

    io.emit('dashboard_update', getDashboardData());
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Added shopping item #${item.id} "${text}"`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, `✅ *Added to shopping list:*\n\n• ${escapeMd(text)}`);
  });

  bot.command('timer', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const text = ctx.message.text.replace(/^\/timer\s*/i, '').trim();
    const minutes = Number(text) || 0;
    if (!minutes || minutes <= 0) return ctx.reply('Usage: /timer <minutes>');
    io.emit('timer:set', { minutes, action: 'start' });
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Started timer for ${minutes} minutes`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, `⏳ *Kitchen timer set for ${minutes} minutes!*`);
  });

  bot.command('photos', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const photos = getPhotos({ screensaverOnly: false });
    if (photos.length === 0) {
      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: 'Listed photos (empty)',
        status: 'success'
      });
      return ctx.reply('🖼️ No photos yet. Send me a photo to add it to the screensaver!');
    }

    let reply = `🖼️ *Screensaver Photos (${photos.length}):*\n\n`;
    for (const p of photos) {
      const inSS = p.show_in_screensaver ? '✅' : '❌';
      const cap = p.caption ? ` — ${p.caption}` : '';
      reply += `• *#${p.id}* ${inSS}${cap} _(${p.source})_\n`;
    }
    reply += `\nSend a photo to add more!`;
    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Listed ${photos.length} photos`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, reply);
  });

  bot.command('school', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const login = process.env.LIBRUS_LOGIN;
    const password = process.env.LIBRUS_PASSWORD;

    if (!login || !password) {
      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: 'Requested school info but credentials not configured',
        status: 'error',
        error_message: 'Missing Librus credentials'
      });
      return ctx.reply('📚 School sync is not configured. Set LIBRUS_LOGIN and LIBRUS_PASSWORD in the environment first.');
    }

    try {
      const data = await fetchLibrusData({ login, password });
      const summary = buildMorningSummary(senderProfile || { name: ctx.from.first_name || 'Student' }, data.normalizedTimetable || data.timetable);
      const notifications = (data.notifications || []).slice(0, 3);

      const parts = [`📚 *School Summary*\n\n${summary}`];
      if (notifications.length > 0) {
        parts.push(`\n*Notifications:*\n${notifications.map((n) => `• ${escapeMd(n.title || n.name || 'Notice')}`).join('\n')}`);
      }

      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: 'Retrieved Librus school summary and notifications',
        status: 'success'
      });
      await safeReplyMarkdown(ctx, parts.join('\n'));
    } catch (err) {
      console.error('[Telegram] School sync failed:', err.message);
      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: 'Failed to retrieve Librus data',
        status: 'error',
        error_message: err.message
      });
      await ctx.reply(`❌ Failed to load school data: ${err.message}`);
    }
  });

  // Command: /today — Today's events and tasks overview
  bot.command('today', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const todayStr = new Date().toISOString().slice(0, 10);
    const allEvents = getCalendarEvents({ limit: 100 });
    const todayEvents = allEvents.filter(e => e.start_datetime && e.start_datetime.startsWith(todayStr));
    const taskList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
    const tasks = (taskList.items || []).filter(item => item.checked !== 1);

    let reply = `📅 *Today's Schedule & Tasks (${todayStr}):*\n\n`;
    if (todayEvents.length === 0) {
      reply += `_No calendar events scheduled for today._\n\n`;
    } else {
      reply += `*Events:*\n`;
      for (const ev of todayEvents) {
        let timeStr = 'All Day';
        if (!ev.all_day && ev.start_datetime.includes('T')) {
          timeStr = ev.start_datetime.split('T')[1].slice(0, 5);
        }
        reply += `• *${timeStr}* — ${escapeMd(ev.title)} _(#${ev.id})_\n`;
      }
      reply += `\n`;
    }

    if (tasks.length === 0) {
      reply += `_No pending tasks! 🎉_`;
    } else {
      reply += `*Pending Tasks (${tasks.length}):*\n`;
      for (const t of tasks.slice(0, 5)) {
        const who = t.assignee_name ? `(@${escapeMd(t.assignee_name)}) ` : '';
        reply += `• #${t.id}: ${escapeMd(t.content)} ${who}\n`;
      }
      if (tasks.length > 5) reply += `_...and ${tasks.length - 5} more._\n`;
    }

    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Reported today overview: ${todayEvents.length} events, ${tasks.length} pending tasks`,
      status: 'success'
    });
    await safeReplyMarkdown(ctx, reply);
  });

  // Command: /event <YYYY-MM-DD> <HH:MM> <title>
  bot.command('event', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 4) {
      return ctx.reply('Usage: /event <YYYY-MM-DD> <HH:MM> <title>\nExample: /event 2026-09-25 18:00 Soccer match');
    }

    const dateStr = normalizeDateString(parts[1]) || parts[1];
    const timeStr = parts[2];
    const title = parts.slice(3).join(' ');

    const startIso = `${dateStr}T${timeStr}:00`;
    try {
      const ev = insertCalendarEvent({
        title,
        start_datetime: startIso,
        all_day: 0,
        source: 'telegram'
      });
      io.emit('dashboard_update', getDashboardData());
      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: `Created calendar event #${ev.id} "${title}" on ${startIso}`,
        status: 'success'
      });
      await safeReplyMarkdown(ctx, `✅ *Calendar Event Added!*\n\n📅 *${escapeMd(title)}*\n🕒 ${dateStr} at ${timeStr}`);
    } catch (err) {
      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: 'Failed to create calendar event',
        status: 'error',
        error_message: err.message
      });
      await ctx.reply(`❌ Failed to add event: ${err.message}`);
    }
  });

  // Command: /done <id>
  bot.command('done', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    const args = ctx.message.text.split(' ').slice(1);
    const taskId = parseInt(args[0], 10);

    if (isNaN(taskId)) {
      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: 'Invalid syntax for /done',
        status: 'error',
        error_message: 'Invalid task ID'
      });
      return ctx.reply('Usage: /done <task_id>  e.g. /done 3');
    }

    // Check list_items first (primary task store for kiosk and admin)
    const taskLists = getLists();
    for (const list of taskLists) {
      if (Array.isArray(list.items)) {
        const found = list.items.find(item => item.id === taskId);
        if (found) {
          toggleListItemChecked(found.id, true, senderName);
          io.emit('dashboard_update', getDashboardData());
          insertAuditLog({
            source: 'telegram_command',
            sender_id: senderId,
            sender_name: senderName,
            message_type: 'command',
            raw_input: ctx.message.text,
            action_taken: `Marked list task #${found.id} "${found.content}" completed`,
            status: 'success'
          });
          await ctx.reply(`✅ Task #${taskId} "${found.content}" marked complete!`);
          return;
        }
      }
    }

    // Fallback: check legacy tasks table
    const tasks = getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      updateTaskStatus(taskId, 'completed', senderName);
      io.emit('dashboard_update', getDashboardData());
      insertAuditLog({
        source: 'telegram_command',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'command',
        raw_input: ctx.message.text,
        action_taken: `Marked legacy task #${task.id} "${task.title}" completed`,
        status: 'success'
      });
      await ctx.reply(`✅ Task #${taskId} "${task.title}" marked complete!`);
      return;
    }

    insertAuditLog({
      source: 'telegram_command',
      sender_id: senderId,
      sender_name: senderName,
      message_type: 'command',
      raw_input: ctx.message.text,
      action_taken: `Task #${taskId} not found`,
      status: 'error',
      error_message: `Task #${taskId} not found`
    });
    return ctx.reply(`❌ Task #${taskId} not found.`);
  });

  // Handle interactive inline keyboard button callbacks
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery?.data || '';
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');

    try {
      const safeEdit = (text, keyboard) => safeEditMarkdown(ctx, text, keyboard);

      if (data === 'menu:home') {
        await ctx.answerCbQuery();
        await safeEdit(`🏠 *Smart Home Dashboard Menu*\nSelect a section below:`, buildMainMenuKeyboard());
        return;
      }

      if (data === 'menu:list:shopping') {
        await ctx.answerCbQuery();
        const list = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
        const { text, keyboard } = buildListKeyboardAndText(list.id, false);
        await safeEdit(text, keyboard);
        return;
      }

      if (data === 'menu:list:tasks') {
        await ctx.answerCbQuery();
        const list = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
        const { text, keyboard } = buildListKeyboardAndText(list.id, false);
        await safeEdit(text, keyboard);
        return;
      }

      if (data.startsWith('menu:list_id:')) {
        await ctx.answerCbQuery();
        const listId = Number(data.split(':')[2]);
        const { text, keyboard } = buildListKeyboardAndText(listId, false);
        await safeEdit(text, keyboard);
        return;
      }

      if (data.startsWith('menu:list_resolved:')) {
        await ctx.answerCbQuery();
        const listId = Number(data.split(':')[2]);
        const { text, keyboard } = buildListKeyboardAndText(listId, true);
        await safeEdit(text, keyboard);
        return;
      }

      if (data === 'menu:lists_all') {
        await ctx.answerCbQuery();
        const allLists = getLists();
        let reply = `📋 *All Lists (${allLists.length}):*\n\n`;
        const buttons = [];
        for (const l of allLists) {
          const activeCount = (l.items || []).filter(i => i.checked !== 1).length;
          reply += `• ${l.icon || '📋'} *${escapeMd(l.name)}* (${activeCount} active)\n`;
          buttons.push([Markup.button.callback(`${l.icon || '📋'} ${l.name} (${activeCount})`, `menu:list_id:${l.id}`)]);
        }
        buttons.push([Markup.button.callback('🏠 Main Menu', 'menu:home')]);
        await safeEdit(reply, Markup.inlineKeyboard(buttons));
        return;
      }

      if (data.startsWith('item:toggle:')) {
        const parts = data.split(':');
        const itemId = Number(parts[2]);
        const targetChecked = parts[3] === '1';
        const updated = toggleListItemChecked(itemId, targetChecked, senderName);
        io.emit('dashboard_update', getDashboardData());
        await ctx.answerCbQuery(targetChecked ? `✅ Checked by ${senderName}` : '↩️ Restored');
        if (updated) {
          const { text, keyboard } = buildListKeyboardAndText(updated.list_id, !targetChecked);
          await safeEdit(text, keyboard);
        }
        return;
      }

      if (data.startsWith('item:del:')) {
        const parts = data.split(':');
        const itemId = Number(parts[2]);
        const listId = Number(parts[3]);
        deleteListItem(itemId);
        io.emit('dashboard_update', getDashboardData());
        await ctx.answerCbQuery('🗑️ Item deleted');
        const { text, keyboard } = buildListKeyboardAndText(listId, false);
        await safeEdit(text, keyboard);
        return;
      }

      if (data.startsWith('list:clear:')) {
        const listId = Number(data.split(':')[2]);
        clearCompletedListItems(listId);
        io.emit('dashboard_update', getDashboardData());
        await ctx.answerCbQuery('🧹 Cleared completed items');
        const { text, keyboard } = buildListKeyboardAndText(listId, false);
        await safeEdit(text, keyboard);
        return;
      }

      if (data === 'menu:notes') {
        await ctx.answerCbQuery();
        const notes = getNotes(12);
        let reply = `📝 *Notes (${notes.length}):*\n\n`;
        const buttons = [];
        if (notes.length === 0) {
          reply += `_No notes yet. Send /addnote <text> to add one._\n`;
        } else {
          for (const n of notes) {
            reply += `• *#${n.id}:* ${escapeMd(n.content)}\n`;
            buttons.push([Markup.button.callback(`🗑️ Delete #${n.id}: ${n.content.slice(0, 20)}`, `note:del:${n.id}`)]);
          }
        }
        buttons.push([Markup.button.callback('🏠 Main Menu', 'menu:home')]);
        await safeEdit(reply, Markup.inlineKeyboard(buttons));
        return;
      }

      if (data.startsWith('note:del:')) {
        const noteId = Number(data.split(':')[2]);
        deleteNote(noteId);
        io.emit('dashboard_update', getDashboardData());
        await ctx.answerCbQuery('🗑️ Note deleted');
        const notes = getNotes(12);
        let reply = `📝 *Notes (${notes.length}):*\n\n`;
        const buttons = [];
        for (const n of notes) {
          reply += `• *#${n.id}:* ${escapeMd(n.content)}\n`;
          buttons.push([Markup.button.callback(`🗑️ Delete #${n.id}: ${n.content.slice(0, 20)}`, `note:del:${n.id}`)]);
        }
        buttons.push([Markup.button.callback('🏠 Main Menu', 'menu:home')]);
        await safeEdit(reply, Markup.inlineKeyboard(buttons));
        return;
      }

      if (data.startsWith('menu:meals:')) {
        await ctx.answerCbQuery();
        const mode = data.split(':')[2] || 'today';
        const { text, keyboard } = buildMealMenuMessage(mode);
        await safeEdit(text, keyboard);
        return;
      }

      if (data === 'menu:dishes') {
        await ctx.answerCbQuery();
        const dishes = getDishes();
        let reply = `🍲 *Dish Catalog (${dishes.length}):*\n\n`;
        const buttons = [];
        for (const d of dishes.slice(0, 12)) {
          const tags = (d.tags || []).length ? ` _[${d.tags.join(', ')}]_` : '';
          reply += `• *${d.name}*${tags}\n`;
          buttons.push([
            Markup.button.callback(`📖 ${d.name}`, `dish:view:${d.id}`),
            Markup.button.callback(`🛒 +Shop`, `dish:shop:${d.id}`)
          ]);
        }
        buttons.push([Markup.button.callback('🍽️ Back to Meal Menu', 'menu:meals:today')]);
        await safeEdit(reply, Markup.inlineKeyboard(buttons));
        return;
      }

      if (data.startsWith('dish:view:')) {
        await ctx.answerCbQuery();
        const dishId = Number(data.split(':')[2]);
        const dish = getDishById(dishId);
        if (!dish) return;
        const tags = (dish.tags || []).length ? `\n🏷️ *Tags:* ${dish.tags.join(', ')}` : '';
        const ing = (dish.ingredients || []).length
          ? `\n\n🥕 *Ingredients:*\n${dish.ingredients.map(i => `• ${i}`).join('\n')}`
          : '\n\n_No ingredients listed._';
        const recipe = dish.recipe ? `\n\n👩‍🍳 *Recipe:*\n${dish.recipe}` : '';
        const text = `🍲 *${dish.name}*${tags}${ing}${recipe}`;
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Add Ingredients to Shopping List', `dish:shop:${dish.id}`)],
          [Markup.button.callback('⬅️ Back to Dishes', 'menu:dishes'), Markup.button.callback('🍽️ Meal Menu', 'menu:meals:today')]
        ]);
        await safeEdit(text, kb);
        return;
      }

      if (data.startsWith('dish:shop:')) {
        const dishId = Number(data.split(':')[2]);
        const dish = getDishById(dishId);
        if (!dish || !Array.isArray(dish.ingredients) || dish.ingredients.length === 0) {
          await ctx.answerCbQuery('No ingredients on this dish');
          return;
        }
        const shoppingList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
        for (const ing of dish.ingredients) {
          insertListItem({ list_id: shoppingList.id, content: ing });
        }
        io.emit('dashboard_update', getDashboardData());
        await ctx.answerCbQuery(`🛒 Added ${dish.ingredients.length} ingredients to Shopping List!`);
        return;
      }

      if (data.startsWith('meals:shop:')) {
        const menuId = Number(data.split(':')[2]);
        const menu = getMealMenuById(menuId) || getActiveMealMenu();
        if (!menu) {
          await ctx.answerCbQuery('No active menu');
          return;
        }
        const dishesById = Object.fromEntries(getDishes().map(d => [String(d.id), d]));
        const ingredients = [];
        for (const dayObj of Object.values(menu.schedule || {})) {
          for (const entries of Object.values(dayObj || {})) {
            for (const entry of (Array.isArray(entries) ? entries : [])) {
              const dish = entry.dish_id ? dishesById[String(entry.dish_id)] : null;
              if (dish && Array.isArray(dish.ingredients)) {
                ingredients.push(...dish.ingredients);
              }
            }
          }
        }
        const shoppingList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
        for (const ing of ingredients) {
          insertListItem({ list_id: shoppingList.id, content: ing });
        }
        io.emit('dashboard_update', getDashboardData());
        await ctx.answerCbQuery(`🛒 Added ${ingredients.length} ingredients to Shopping List!`);
        return;
      }

      if (data === 'menu:today') {
        await ctx.answerCbQuery();
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayEvents = getCalendarEvents({ limit: 50 }).filter(e => e.start_datetime && e.start_datetime.startsWith(todayStr));
        const taskList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
        const pendingTasks = (taskList.items || []).filter(i => i.checked !== 1);
        let reply = `📅 *Today (${todayStr}):*\n\n`;
        reply += todayEvents.length
          ? `*Events:*\n${todayEvents.map(e => `• ${e.title}`).join('\n')}\n\n`
          : `_No events today._\n\n`;
        reply += pendingTasks.length
          ? `*Pending Tasks (${pendingTasks.length}):*\n${pendingTasks.slice(0, 8).map(t => `• ${t.content}`).join('\n')}`
          : `_All tasks done!_`;
        await safeEdit(reply, Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'menu:home')]]));
        return;
      }

      if (data === 'menu:rewards') {
        await ctx.answerCbQuery();
        const { text, keyboard } = buildRewardsMessage(senderProfile);
        await safeEdit(text, keyboard);
        return;
      }

      if (data.startsWith('reward:redeem:')) {
        const parts = data.split(':');
        const rewardId = Number(parts[2]);
        const profileId = Number(parts[3]) || (senderProfile ? senderProfile.id : null);
        const result = redeemReward(profileId, rewardId);
        if (!result.ok) {
          await ctx.answerCbQuery(`❌ ${result.error}`);
          return;
        }
        io.emit('dashboard_update', getDashboardData());
        await ctx.answerCbQuery(`🎉 Redeemed ${result.reward.title}! (-${result.reward.cost} ⭐)`);
        const { text, keyboard } = buildRewardsMessage(result.profile);
        await safeEdit(text, keyboard);
        return;
      }

      if (data === 'menu:status') {
        await ctx.answerCbQuery();
        const tasksList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
        const shoppingList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
        const notes = getNotes(10);
        const reply = `📊 *Dashboard Status*\n\n` +
          `• Pending Tasks: ${(tasksList.items || []).filter(i => i.checked !== 1).length}\n` +
          `• Unchecked Shopping: ${(shoppingList.items || []).filter(i => i.checked !== 1).length}\n` +
          `• Active Notes: ${notes.length}`;
        await safeEdit(reply, Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'menu:home')]]));
        return;
      }

      await ctx.answerCbQuery();
    } catch (err) {
      console.error('[Telegram] Callback error:', err.message);
      try { await ctx.answerCbQuery('Error processing action'); } catch (_) {}
    }
  });

  // Handle incoming PHOTO messages — save to screensaver
  bot.on('photo', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    try {
      await ctx.reply('📷 Saving photo to dashboard screensaver...');
      const photo = await saveTelegramPhoto(ctx, io);
      const cap = photo.caption ? `\n_"${escapeMd(photo.caption)}"_` : '';
      insertAuditLog({
        source: 'telegram_photo',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'photo',
        raw_input: photo.caption || photo.filename,
        action_taken: `Saved photo #${photo.id} (${photo.filename}) to screensaver`,
        status: 'success'
      });
      await safeReplyMarkdown(ctx, `✅ Photo added to screensaver slideshow! 🖼️${cap}\n\nID: #${photo.id}`);
    } catch (err) {
      insertAuditLog({
        source: 'telegram_photo',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'photo',
        raw_input: ctx.message?.caption || null,
        action_taken: 'Failed to save photo',
        status: 'error',
        error_message: err.message
      });
      await ctx.reply(`❌ Failed to save photo: ${err.message}`);
    }
  });

  // Handle incoming voice audio messages (Speech-to-Action via Gemini)
  bot.on('voice', async (ctx) => {
    const senderId = String(ctx.from.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from.first_name || 'User');
    console.log(`[Telegram] Voice message received from ${senderName} (${senderId})`);

    try {
      await ctx.reply('🎙️ Processing voice note with Gemini AI...');

      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const fileRef = ctx.message.voice;
      const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileRef.file_id}`;

      const fileInfo = await new Promise((resolve, reject) => {
        https.get(fileInfoUrl, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(JSON.parse(data)));
          res.on('error', reject);
        });
      });

      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;

      const audioBuffer = await new Promise((resolve, reject) => {
        https.get(downloadUrl, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
      });

      const parsedData = await parseAudioWithGemini(audioBuffer, 'audio/ogg', senderName);
      const { summary } = await applyParsedGeminiActions(parsedData, senderProfile, io);

      insertAuditLog({
        source: 'telegram_voice',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'voice',
        raw_input: `Voice message (${fileRef.duration || 0}s)`,
        parsed_payload: parsedData,
        action_taken: summary,
        status: 'success'
      });

      const replyMsg = buildConfirmationMessage(parsedData, senderProfile);
      await safeReplyMarkdown(ctx, replyMsg);

      if (!parsedData.tasks?.length && !parsedData.shopping_items?.length && !parsedData.calendar_events?.length && !parsedData.meal_actions?.length && !parsedData.notes?.length) {
        const voiceIntent = detectListQueryIntent(parsedData.response_message);
        if (voiceIntent) {
          if (voiceIntent.type === 'shopping') {
            const list = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
            const { text, keyboard } = buildListKeyboardAndText(list.id, false);
            await safeReplyMarkdown(ctx, text, keyboard);
          } else if (voiceIntent.type === 'tasks') {
            const list = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
            const { text, keyboard } = buildListKeyboardAndText(list.id, false);
            await safeReplyMarkdown(ctx, text, keyboard);
          }
        }
      }
    } catch (err) {
      console.error('[Telegram] Failed to process voice message:', err);
      insertAuditLog({
        source: 'telegram_voice',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'voice',
        raw_input: 'Voice message',
        action_taken: 'Failed to process voice note',
        status: 'error',
        error_message: err.message
      });
      await ctx.reply(`❌ Failed to process voice: ${err.message}`);
    }
  });

  // Handle incoming text messages (natural language → Gemini)
  bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    if (userText.startsWith('/')) return; // Ignore unhandled commands

    const senderId = String(ctx.from.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from.first_name || 'User');
    console.log(`[Telegram] Message from ${senderName} (${senderId}): "${userText}"`);

    // Natural Language list query intent detection
    const listIntent = detectListQueryIntent(userText);
    if (listIntent) {
      if (listIntent.type === 'shopping') {
        const list = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
        const { text, keyboard } = buildListKeyboardAndText(list.id, false);
        return await safeReplyMarkdown(ctx, text, keyboard);
      }
      if (listIntent.type === 'tasks') {
        const list = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
        const { text, keyboard } = buildListKeyboardAndText(list.id, false);
        return await safeReplyMarkdown(ctx, text, keyboard);
      }
      if (listIntent.type === 'all') {
        const allLists = getLists();
        let reply = `📋 *All Lists (${allLists.length}):*\n\n`;
        const buttons = [];
        for (const l of allLists) {
          const activeCount = (l.items || []).filter(i => Number(i.checked) !== 1).length;
          reply += `• ${l.icon || '📋'} *${escapeMd(l.name)}* (${activeCount} active)\n`;
          buttons.push([Markup.button.callback(`${l.icon || '📋'} ${l.name} (${activeCount})`, `menu:list_id:${l.id}`)]);
        }
        buttons.push([Markup.button.callback('🏠 Main Menu', 'menu:home')]);
        return await safeReplyMarkdown(ctx, reply, Markup.inlineKeyboard(buttons));
      }
      if (listIntent.type === 'named') {
        const allLists = getLists();
        const target = allLists.find(l => (l.name || '').toLowerCase().includes(listIntent.name.toLowerCase()));
        if (target) {
          const { text, keyboard } = buildListKeyboardAndText(target.id, false);
          return await safeReplyMarkdown(ctx, text, keyboard);
        }
      }
    }

    try {
      const parsedData = await parseTextWithGemini(userText, senderName);
      const { summary } = await applyParsedGeminiActions(parsedData, senderProfile, io);

      insertAuditLog({
        source: 'telegram_text',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'text',
        raw_input: userText,
        parsed_payload: parsedData,
        action_taken: summary,
        status: 'success'
      });

      const replyMsg = buildConfirmationMessage(parsedData, senderProfile);
      await safeReplyMarkdown(ctx, replyMsg);
    } catch (err) {
      console.error('[Telegram] Error processing message:', err);
      insertAuditLog({
        source: 'telegram_text',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'text',
        raw_input: userText,
        action_taken: 'Failed to parse/save message with Gemini',
        status: 'error',
        error_message: err.message
      });
      await ctx.reply(`❌ Failed to parse/save message: ${err.message}`);
    }
  });

  bot.launch()
    .then(() => console.log('[Telegram] Bot polling started successfully'))
    .catch((err) => console.error('[Telegram] Bot launch failed:', err.message));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = {
  initBot,
  applyParsedGeminiActions,
  getOrCreateDashboardList,
  resolveProfileIdFromName,
  normalizeDateString,
  buildRewardsMessage,
  escapeMd,
  safeReplyMarkdown,
  safeEditMarkdown,
  detectListQueryIntent,
  buildListKeyboardAndText,
  buildConfirmationMessage
};
