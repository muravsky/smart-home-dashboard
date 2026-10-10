const { Telegraf } = require('telegraf');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { parseTextWithGemini, parseAudioWithGemini } = require('./services/gemini');
const { fetchLibrusData, normalizeTimetableData, buildMorningSummary } = require('./services/librus');
const {
  insertNote,
  insertTask,
  getDashboardData,
  getNotes,
  getTasks,
  updateTaskStatus,
  insertPhoto,
  getPhotos,
  getCalendarEvents,
  insertCalendarEvent,
  getProfileByTelegramId,
  getProfiles,
  getLists,
  insertList,
  insertListItem,
  updateList,
  toggleListItemChecked,
  insertAuditLog
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
    const filename = `photo-${Date.now()}-tg${ext}`;
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

    const photo = insertPhoto({
      filename,
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

function getOrCreateDashboardList(type, name, icon = '📋') {
  const allLists = getLists();
  const existing = allLists.find((list) => list.type === type);
  if (existing) return existing;
  return insertList({ name, type, icon });
}

function resolveProfileIdFromName(rawName, senderProfile) {
  if (!rawName) return senderProfile ? senderProfile.id : null;
  const normalized = String(rawName).trim().toLowerCase();
  if (!normalized) return senderProfile ? senderProfile.id : null;

  const profiles = getProfiles();
  const exactMatch = profiles.find((profile) => (profile.name || '').toLowerCase() === normalized);
  if (exactMatch) return exactMatch.id;

  const partialMatch = profiles.find((profile) => (profile.name || '').toLowerCase().includes(normalized));
  return partialMatch ? partialMatch.id : (senderProfile ? senderProfile.id : null);
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

// Helper: execute all actions returned by Gemini
async function applyParsedGeminiActions(parsedData, senderProfile, ioInstance = null) {
  const { notes, tasks, shopping_items, calendar_events, timer } = parsedData || {};
  const senderName = senderProfile ? senderProfile.name : null;
  const senderId = senderProfile ? senderProfile.id : null;
  const actionsSummary = [];

  if (Array.isArray(notes) && notes.length > 0) {
    for (const note of notes) {
      const content = senderName ? `[${senderName}]: ${note}` : note;
      insertNote(content);
    }
    actionsSummary.push(`Added ${notes.length} note(s)`);
  }

  if (Array.isArray(tasks) && tasks.length > 0) {
    const tasksList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
    for (const task of tasks) {
      const assigneeProfileId = resolveProfileIdFromName(task.assignee || senderName, senderProfile);
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
        assignee: task.assignee || senderName,
        reward: Number(task.reward) || 0
      });
    }
    actionsSummary.push(`Created ${tasks.length} task(s)`);
  }

  if (Array.isArray(shopping_items) && shopping_items.length > 0) {
    const shopList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
    for (const item of shopping_items) {
      insertListItem({
        list_id: shopList.id,
        content: item.content,
        assignee_profile_id: senderId,
        reward: 0
      });
    }
    actionsSummary.push(`Added ${shopping_items.length} shopping item(s)`);
  }

  if (Array.isArray(calendar_events) && calendar_events.length > 0) {
    for (const ev of calendar_events) {
      const startIso = ev.time ? `${ev.date}T${ev.time}:00` : `${ev.date}T09:00:00`;
      insertCalendarEvent({
        title: ev.title,
        start_datetime: startIso,
        all_day: ev.all_day ? 1 : 0,
        profile_id: senderId,
        source: 'telegram'
      });
    }
    actionsSummary.push(`Scheduled ${calendar_events.length} event(s)`);
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
  const { notes, tasks, shopping_items, calendar_events, timer, response_message } = parsedData || {};
  const greeting = senderProfile ? `👋 *Hi ${senderProfile.name}!*` : `✅ *Smart Home Dashboard Updated!*`;
  let msg = `${greeting}\n`;

  if (response_message) {
    msg += `_${response_message}_\n\n`;
  }

  if (tasks && tasks.length > 0) {
    msg += `📋 *Tasks created:*\n` + tasks.map(t => {
      const who = t.assignee ? `(@${t.assignee}) ` : '';
      const rew = t.reward ? ` [+${t.reward}]` : '';
      return `• ${t.title} ${who}${rew}`;
    }).join('\n') + '\n';
  }

  if (shopping_items && shopping_items.length > 0) {
    msg += `🛒 *Shopping list updated:*\n` + shopping_items.map(s => `• ${s.content}`).join('\n') + '\n';
  }

  if (calendar_events && calendar_events.length > 0) {
    msg += `📅 *Calendar events scheduled:*\n` + calendar_events.map(e => `• ${e.title} (${e.date} ${e.time || ''})`).join('\n') + '\n';
  }

  if (notes && notes.length > 0) {
    msg += `📝 *Notes saved:*\n` + notes.map(n => `• ${n}`).join('\n') + '\n';
  }

  if (timer && timer.minutes) {
    msg += `⏳ *Kitchen Timer:* Set for ${timer.minutes} minutes!\n`;
  }

  if (!tasks?.length && !shopping_items?.length && !calendar_events?.length && !notes?.length && !timer) {
    msg += `_(No specific actions detected)_`;
  }

  return msg.trim();
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

  // Command: /start or /help
  bot.command(['start', 'help'], async (ctx) => {
    const msg =
      `👋 *Welcome to your Smart Home Dashboard Bot!*\n\n` +
      `You can send natural-language messages and Gemini will turn them into tasks, notes, shopping items, events, or timers.\n\n` +
      `*Commands:*\n` +
      `• /tasks — View chores and task list\n` +
      `• /shopping — View shopping list\n` +
      `• /notes — View recent notes\n` +
      `• /today — Today's events and tasks\n` +
      `• /addtask <title> [reward] [assignee] — Add a task\n` +
      `• /addnote <text> — Save a note\n` +
      `• /addshopping <item> — Add shopping item\n` +
      `• /event <YYYY-MM-DD> <HH:MM> <title> — Add event\n` +
      `• /timer <minutes> — Start kitchen timer\n` +
      `• /done <id> — Mark a task item complete\n` +
      `• /photos — List screensaver photos\n` +
      `• /help — Show this message`;
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/help',
      action_taken: 'Displayed help menu',
      status: 'success'
    });
    await ctx.replyWithMarkdown(msg);
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
    await ctx.replyWithMarkdown(reply);
  });

  bot.command('tasks', async (ctx) => {
    const taskList = getOrCreateDashboardList('tasks', 'Family Tasks', '✅');
    const items = Array.isArray(taskList.items) ? taskList.items : [];
    if (items.length === 0) {
      insertAuditLog({
        source: 'telegram_command',
        sender_id: String(ctx.from?.id),
        sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
        message_type: 'command',
        raw_input: ctx.message?.text || '/tasks',
        action_taken: 'Listed tasks (empty)',
        status: 'success'
      });
      return ctx.reply('📋 No tasks recorded yet.');
    }

    let reply = `📋 *Tasks (${items.length}):*\n\n`;
    for (const item of items) {
      const checked = item.checked === 1 ? '✅' : '⏳';
      const due = item.due_date ? ` • ${item.due_date}` : '';
      const reward = item.reward ? ` • +${item.reward} pts` : '';
      const assignee = item.assignee_name ? ` • @${item.assignee_name}` : '';
      reply += `${checked} #${item.id}: ${item.content}${assignee}${due}${reward}\n`;
    }
    reply += `\n_Tip: /done <id> to complete a task._`;
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/tasks',
      action_taken: `Listed ${items.length} tasks`,
      status: 'success'
    });
    await ctx.replyWithMarkdown(reply);
  });

  bot.command('shopping', async (ctx) => {
    const shoppingList = getOrCreateDashboardList('shopping', 'Shopping List', '🛒');
    const items = Array.isArray(shoppingList.items) ? shoppingList.items : [];
    if (items.length === 0) {
      insertAuditLog({
        source: 'telegram_command',
        sender_id: String(ctx.from?.id),
        sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
        message_type: 'command',
        raw_input: ctx.message?.text || '/shopping',
        action_taken: 'Listed shopping (empty)',
        status: 'success'
      });
      return ctx.reply('🛒 Shopping list is empty.');
    }

    let reply = `🛒 *Shopping List (${items.length}):*\n\n`;
    for (const item of items) {
      const checked = item.checked === 1 ? '✅' : '⬜';
      reply += `${checked} ${item.content}\n`;
    }
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/shopping',
      action_taken: `Listed ${items.length} shopping items`,
      status: 'success'
    });
    await ctx.replyWithMarkdown(reply);
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
      return ctx.reply('📝 No notes recorded yet.');
    }

    let reply = `📝 *Recent Notes (${notes.length}):*\n\n`;
    for (const n of notes) reply += `• ${n.content}\n`;
    insertAuditLog({
      source: 'telegram_command',
      sender_id: String(ctx.from?.id),
      sender_name: ctx.from?.first_name || ctx.from?.username || 'User',
      message_type: 'command',
      raw_input: ctx.message?.text || '/notes',
      action_taken: `Listed ${notes.length} notes`,
      status: 'success'
    });
    await ctx.replyWithMarkdown(reply);
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
    await ctx.replyWithMarkdown(`✅ *Note saved:*\n\n_${note.content}_`);
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
    await ctx.replyWithMarkdown(`✅ *Task added:*\n\n• #${item.id} ${title.trim()}${reward ? ` [+${reward} pts]` : ''}`);
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
    await ctx.replyWithMarkdown(`✅ *Added to shopping list:*\n\n• ${text}`);
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
    await ctx.replyWithMarkdown(`⏳ *Kitchen timer set for ${minutes} minutes!*`);
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
    await ctx.replyWithMarkdown(reply);
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
        parts.push(`\n*Notifications:*\n${notifications.map((n) => `• ${n.title || n.name || 'Notice'}`).join('\n')}`);
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
      await ctx.replyWithMarkdown(parts.join('\n'));
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
        reply += `• *${timeStr}* — ${ev.title}\n`;
      }
      reply += `\n`;
    }

    if (tasks.length === 0) {
      reply += `_No pending tasks! 🎉_`;
    } else {
      reply += `*Pending Tasks (${tasks.length}):*\n`;
      for (const t of tasks.slice(0, 5)) {
        const who = t.assignee_name ? `(@${t.assignee_name}) ` : '';
        reply += `• #${t.id}: ${t.content} ${who}\n`;
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
    await ctx.replyWithMarkdown(reply);
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
      await ctx.replyWithMarkdown(`✅ *Calendar Event Added!*\n\n📅 *${title}*\n🕒 ${dateStr} at ${timeStr}`);
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
          toggleListItemChecked(found.id, true);
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
      updateTaskStatus(taskId, 'completed');
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

  // Handle incoming PHOTO messages — save to screensaver
  bot.on('photo', async (ctx) => {
    const senderId = String(ctx.from?.id);
    const senderProfile = getProfileByTelegramId(senderId);
    const senderName = senderProfile ? senderProfile.name : (ctx.from?.first_name || 'User');
    try {
      await ctx.reply('📷 Saving photo to dashboard screensaver...');
      const photo = await saveTelegramPhoto(ctx, io);
      const cap = photo.caption ? `\n_"${photo.caption}"_` : '';
      insertAuditLog({
        source: 'telegram_photo',
        sender_id: senderId,
        sender_name: senderName,
        message_type: 'photo',
        raw_input: photo.caption || photo.filename,
        action_taken: `Saved photo #${photo.id} (${photo.filename}) to screensaver`,
        status: 'success'
      });
      await ctx.replyWithMarkdown(`✅ Photo added to screensaver slideshow! 🖼️${cap}\n\nID: #${photo.id}`);
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
      await ctx.replyWithMarkdown(replyMsg);
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
      await ctx.replyWithMarkdown(replyMsg);
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
  normalizeDateString
};
