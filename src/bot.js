const { Telegraf } = require('telegraf');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { parseTextWithGemini } = require('./services/gemini');
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
  insertCalendarEvent
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
      return;
    }

    return next();
  });

  // Command: /start or /help
  bot.command(['start', 'help'], async (ctx) => {
    const msg =
      `👋 *Welcome to your Smart Home Dashboard Bot!*\n\n` +
      `Just send me any message and Gemini AI will extract notes and tasks.\n` +
      `Send a *photo* 📷 to add it to the screensaver slideshow!\n\n` +
      `*Commands:*\n` +
      `• /tasks — View all active tasks\n` +
      `• /done <id> — Mark a task as completed\n` +
      `• /notes — View recent notes\n` +
      `• /photos — List screensaver photos\n` +
      `• /help — Show this message`;
    await ctx.replyWithMarkdown(msg);
  });

  // Command: /tasks
  bot.command('tasks', async (ctx) => {
    const tasks = getTasks();
    if (tasks.length === 0) return ctx.reply('📋 No tasks recorded yet.');

    let reply = `📋 *Active Tasks (${tasks.length}):*\n\n`;
    for (const t of tasks) {
      const statusIcon = t.status === 'completed' ? '✅' : '⏳';
      const who = t.assignee ? `(@${t.assignee}) ` : '';
      const rew = t.reward ? `[+${t.reward}] ` : '';
      reply += `${statusIcon} *#${t.id}*: ${t.title} ${who}${rew}\n`;
    }
    reply += `\n_Tip: /done <id> to complete a task._`;
    await ctx.replyWithMarkdown(reply);
  });

  // Command: /done <id>
  bot.command('done', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const taskId = parseInt(args[0], 10);

    if (isNaN(taskId)) return ctx.reply('Usage: /done <task_id>  e.g. /done 3');

    const tasks = getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return ctx.reply(`❌ Task #${taskId} not found.`);

    updateTaskStatus(taskId, 'completed');
    io.emit('dashboard_update', getDashboardData());
    await ctx.reply(`✅ Task #${taskId} "${task.title}" marked complete!`);
  });

  // Command: /notes
  bot.command('notes', async (ctx) => {
    const notes = getNotes(15);
    if (notes.length === 0) return ctx.reply('📝 No notes recorded yet.');

    let reply = `📝 *Recent Notes (${notes.length}):*\n\n`;
    for (const n of notes) reply += `• ${n.content}\n`;
    await ctx.replyWithMarkdown(reply);
  });

  // Command: /photos — List screensaver photos
  bot.command('photos', async (ctx) => {
    const photos = getPhotos({ screensaverOnly: false });
    if (photos.length === 0) {
      return ctx.reply('🖼️ No photos yet. Send me a photo to add it to the screensaver!');
    }

    let reply = `🖼️ *Screensaver Photos (${photos.length}):*\n\n`;
    for (const p of photos) {
      const inSS = p.show_in_screensaver ? '✅' : '❌';
      const cap = p.caption ? ` — ${p.caption}` : '';
      reply += `• *#${p.id}* ${inSS}${cap} _(${p.source})_\n`;
    }
    reply += `\nSend a photo to add more!`;
    await ctx.replyWithMarkdown(reply);
  });

  // Command: /today — Today's events and tasks overview
  bot.command('today', async (ctx) => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const allEvents = getCalendarEvents({ limit: 100 });
    const todayEvents = allEvents.filter(e => e.start_datetime && e.start_datetime.startsWith(todayStr));
    const tasks = getTasks().filter(t => t.status !== 'completed');

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
        const who = t.assignee ? `(@${t.assignee}) ` : '';
        reply += `• #${t.id}: ${t.title} ${who}\n`;
      }
      if (tasks.length > 5) reply += `_...and ${tasks.length - 5} more._\n`;
    }

    await ctx.replyWithMarkdown(reply);
  });

  // Command: /event <YYYY-MM-DD> <HH:MM> <title>
  bot.command('event', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 4) {
      return ctx.reply('Usage: /event <YYYY-MM-DD> <HH:MM> <title>\nExample: /event 2026-09-25 18:00 Soccer match');
    }

    const dateStr = parts[1];
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
      await ctx.replyWithMarkdown(`✅ *Calendar Event Added!*\n\n📅 *${title}*\n🕒 ${dateStr} at ${timeStr}`);
    } catch (err) {
      await ctx.reply(`❌ Failed to add event: ${err.message}`);
    }
  });

  // Handle incoming PHOTO messages — save to screensaver
  bot.on('photo', async (ctx) => {
    try {
      await ctx.reply('📷 Saving photo to dashboard screensaver...');
      const photo = await saveTelegramPhoto(ctx, io);
      const cap = photo.caption ? `\n_"${photo.caption}"_` : '';
      await ctx.replyWithMarkdown(`✅ Photo added to screensaver slideshow! 🖼️${cap}\n\nID: #${photo.id}`);
    } catch (err) {
      await ctx.reply(`❌ Failed to save photo: ${err.message}`);
    }
  });

  // Handle incoming text messages (natural language → Gemini)
  bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    if (userText.startsWith('/')) return; // Ignore unhandled commands

    const senderId = String(ctx.from.id);
    console.log(`[Telegram] Message from authorized user ${senderId}: "${userText}"`);

    try {
      const parsedData = await parseTextWithGemini(userText);
      const { notes, tasks } = parsedData;

      for (const note of notes) insertNote(note);
      for (const task of tasks) insertTask(task);

      const updatedData = getDashboardData();
      io.emit('dashboard_update', updatedData);

      let summary = '✅ *Smart Home Dashboard Updated!*\n';
      if (notes.length > 0) {
        summary += '\n📝 *Notes added:*\n' + notes.map((n) => `• ${n}`).join('\n');
      }
      if (tasks.length > 0) {
        summary += '\n📋 *Tasks created:*\n' + tasks.map((t) => {
          const who = t.assignee ? `(@${t.assignee}) ` : '';
          const rew = t.reward ? ` [+${t.reward}]` : '';
          return `• ${t.title} ${who}${rew}`;
        }).join('\n');
      }
      if (notes.length === 0 && tasks.length === 0) {
        summary += '\n_(No specific notes or tasks detected)_';
      }

      await ctx.replyWithMarkdown(summary);
    } catch (err) {
      console.error('[Telegram] Error processing message:', err);
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

module.exports = { initBot };
