const { Telegraf } = require('telegraf');
const { parseTextWithGemini } = require('./services/gemini');
const {
  insertNote,
  insertTask,
  getDashboardData,
  getNotes,
  getTasks,
  updateTaskStatus
} = require('./db');

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
      return; // Strictly block: ignore message
    }

    return next();
  });

  // Command: /start or /help
  bot.command(['start', 'help'], async (ctx) => {
    const msg = 
      `👋 *Welcome to your Smart Home Dashboard Bot!*\n\n` +
      `Just send me any message in natural language, and Gemini AI will automatically extract notes and tasks for your tablet kiosk.\n\n` +
      `*Examples:*\n` +
      `• _"Bought organic milk and eggs"_\n` +
      `• _"Alex needs to vacuum the living room reward 30"_\n` +
      `• _"Remember to check the water filters tomorrow"_\n\n` +
      `*Commands:*\n` +
      `• /tasks — View all active tasks\n` +
      `• /done <id> — Mark a task as completed\n` +
      `• /notes — View recent notes`;
    await ctx.replyWithMarkdown(msg);
  });

  // Command: /tasks
  bot.command('tasks', async (ctx) => {
    const tasks = getTasks();
    if (tasks.length === 0) {
      return ctx.reply('📋 No tasks recorded yet.');
    }

    let reply = `📋 *Active Tasks (${tasks.length}):*\n\n`;
    for (const t of tasks) {
      const statusIcon = t.status === 'completed' ? '✅' : '⏳';
      const who = t.assignee ? `(@${t.assignee}) ` : '';
      const rew = t.reward ? `[+${t.reward}] ` : '';
      reply += `${statusIcon} *#${t.id}*: ${t.title} ${who}${rew}\n`;
    }
    reply += `\n_Tip: Type /done <id> to complete a task._`;
    await ctx.replyWithMarkdown(reply);
  });

  // Command: /done <id>
  bot.command('done', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const taskId = parseInt(args[0], 10);

    if (isNaN(taskId)) {
      return ctx.reply('Usage: /done <task_id> (e.g. /done 3)');
    }

    const tasks = getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      return ctx.reply(`❌ Task #${taskId} not found.`);
    }

    updateTaskStatus(taskId, 'completed');
    io.emit('dashboard_update', getDashboardData());

    await ctx.reply(`✅ Task #${taskId} "*${task.title}*" marked as completed!`);
  });

  // Command: /notes
  bot.command('notes', async (ctx) => {
    const notes = getNotes(15);
    if (notes.length === 0) {
      return ctx.reply('📝 No notes recorded yet.');
    }

    let reply = `📝 *Recent Notes (${notes.length}):*\n\n`;
    for (const n of notes) {
      reply += `• ${n.content}\n`;
    }
    await ctx.replyWithMarkdown(reply);
  });

  // Handle incoming text messages (natural language flow)
  bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    if (userText.startsWith('/')) return; // Ignore unhandled commands

    const senderId = String(ctx.from.id);
    console.log(`[Telegram] Message from authorized user ${senderId}: "${userText}"`);

    try {
      // 1. Send text to Gemini
      const parsedData = await parseTextWithGemini(userText);
      const { notes, tasks } = parsedData;

      // 2. Insert resulting notes and tasks into SQLite
      for (const note of notes) {
        insertNote(note);
      }
      for (const task of tasks) {
        insertTask(task);
      }

      // 3. Emit dashboard_update event via Socket.IO with the latest data
      const updatedData = getDashboardData();
      io.emit('dashboard_update', updatedData);

      // 4. Reply to the Telegram user with a success summary
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
        summary += '\n_(No specific notes or tasks detected to record)_';
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

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = { initBot };
