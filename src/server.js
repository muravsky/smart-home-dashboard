require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const basicAuth = require('express-basic-auth');

const {
  db,
  insertNote,
  getNoteById,
  updateNote,
  deleteNote,
  getNotes,
  insertTask,
  updateTaskStatus,
  updateTask,
  deleteTask,
  getTasks,
  getDashboardData,
  getProfiles,
  getProfileById,
  getProfileByTelegramId,
  insertProfile,
  updateProfile,
  deleteProfile,
  getSchedules,
  getScheduleById,
  getProfileSchedules,
  insertSchedule,
  upsertLibrusSchedule,
  updateSchedule,
  deleteSchedule,
  getLists,
  getListById,
  insertList,
  updateList,
  deleteList,
  insertListItem,
  toggleListItemChecked,
  updateListItem,
  deleteListItem,
  clearCompletedListItems,
  getWidgetLayouts,
  getAllProfileLayouts,
  saveWidgetLayouts,
  getPageConfigs,
  savePageConfig,
  getSettings,
  updateSettings,
  getPhotos,
  updatePhotoFilename,
  insertPhoto,
  updatePhoto,
  deletePhoto,
  getCalendarFeeds,
  insertCalendarFeed,
  deleteCalendarFeed,
  getCalendarEvents,
  insertCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  deleteOldCalendarEvents,
  getDishes,
  getDishById,
  insertDish,
  updateDish,
  deleteDish,
  getDefaultMealSlots,
  getMealMenus,
  getMealMenuById,
  getActiveMealMenu,
  insertMealMenu,
  updateMealMenu,
  deleteMealMenu,
  applyMealMenuTemplate,
  setMealSlotEntry,
  saveLibrusData,
  getLibrusData,
  insertAuditLog,
  getAuditLogs,
  clearAuditLogs,
  getScheduledSubscriptions,
  upsertScheduledSubscription,
  markScheduledSubscriptionSent,
  pruneData
} = require('./db');
const { parseTextWithGemini, generateSchoolDaySummaryWithGemini, listAvailableGeminiModels } = require('./services/gemini');
const { getWeather, searchCity, clearWeatherCache } = require('./services/weather');
const { fetchLibrusData, normalizeTimetableData, buildSchoolDaySummary } = require('./services/librus');
const { initBot, applyParsedGeminiActions } = require('./bot');
const { createMaintenanceService, SUBSCRIPTION_TYPES } = require('./services/maintenance');
const { uploadAvatar, uploadPhoto, photosDir, createScreensaverDerivative } = require('./middleware/upload');
const { normalizeCalendarUrl, syncFeed, syncAllFeeds, startCalendarSyncCron } = require('./services/calendar');

const app = express();
const liveSettings = getSettings();
const configuredCertPath = process.env.HTTPS_CERT_PATH || process.env.SSL_CERT_PATH || liveSettings.https_cert_path || null;
const configuredKeyPath = process.env.HTTPS_KEY_PATH || process.env.SSL_KEY_PATH || liveSettings.https_key_path || null;
const httpsRequested = Boolean(
  Number(liveSettings.https_enabled || 0) === 1 ||
  (process.env.HTTPS_CERT_PATH && process.env.HTTPS_KEY_PATH) ||
  (process.env.SSL_CERT_PATH && process.env.SSL_KEY_PATH)
);
const sslCertPath = configuredCertPath || null;
const sslKeyPath = configuredKeyPath || null;
const certsExist = Boolean(sslCertPath && sslKeyPath && fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath));
if (httpsRequested && !certsExist) {
  console.warn(`[HTTPS] HTTPS was requested, but certificate files were not found at cert="${sslCertPath}" key="${sslKeyPath}". Falling back to HTTP so the server stays reachable.`);
}
const enableHttps = httpsRequested && certsExist;
const httpsPort = Number(process.env.HTTPS_PORT || liveSettings.https_port || 443) || 443;
const httpPort = Number(process.env.PORT) || 3000;

let server;
let activeHttps = enableHttps;
if (enableHttps) {
  try {
    server = require('https').createServer({
      key: fs.readFileSync(sslKeyPath),
      cert: fs.readFileSync(sslCertPath)
    }, app);
  } catch (err) {
    console.warn(`[HTTPS] Failed to load SSL certificate (${err.message}). Falling back to HTTP.`);
    activeHttps = false;
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

function addIngredientsToShoppingList(rawIngredients = [], assigneeProfileId = null) {
  const cleanItems = (Array.isArray(rawIngredients) ? rawIngredients : [])
    .map(i => String(i || '').trim())
    .filter(Boolean);
  if (!cleanItems.length) return [];

  let shopList = getLists().find(l => l.type === 'shopping');
  if (!shopList) {
    shopList = insertList({ name: 'Shopping List', type: 'shopping', color: '#34d399', icon: '🛒' });
  }
  const added = [];
  for (const ing of cleanItems) {
    const item = insertListItem({
      list_id: shopList.id,
      content: ing,
      assignee_profile_id: assigneeProfileId || null,
      reward: 0
    });
    if (item) added.push(item);
  }
  return added;
}

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Socket.IO authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const expectedToken = process.env.DASHBOARD_TOKEN || 'your_secret_token';

  if (token === expectedToken) {
    return next();
  }

  const err = new Error('Authentication error: invalid dashboard token');
  err.data = { status: 403 };
  next(err);
});

io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Send system info and initial database state to the dashboard
  socket.emit('system:info', {
    status: 'connected',
    time: new Date().toISOString()
  });

  // Push current full state upon connection
  socket.emit('dashboard_update', getDashboardData());

  // Interactive task completion from tablet (legacy task)
  socket.on('task:toggle', ({ id, status, completed_by }) => {
    updateTaskStatus(id, status, completed_by || null);
    io.emit('dashboard_update', getDashboardData());
  });

  // Interactive list item toggle from tablet
  socket.on('list:item:toggle', ({ id, checked, completed_by }) => {
    toggleListItemChecked(id, checked, completed_by || null);
    io.emit('dashboard_update', getDashboardData());
  });

  // Interactive list item addition from tablet
  socket.on('list:item:add', (data) => {
    if (!data || !data.content) return;
    insertListItem({
      list_id: data.listId || data.list_id,
      content: data.content,
      assignee_profile_id: data.assigneeProfileId ?? data.assignee_profile_id ?? null,
      reward: data.reward,
      due_date: data.dueDate || data.due_date || null,
      due_time: data.dueTime || data.due_time || null,
      recurrence: data.recurrence || 'none',
      recurrence_interval: data.recurrenceInterval || data.recurrence_interval || 1,
      recurrence_days: data.recurrenceDays || data.recurrence_days || null
    });
    io.emit('dashboard_update', getDashboardData());
  });

  // Interactive list item update from tablet
  socket.on('list:item:update', (data) => {
    if (!data || !data.id) return;
    updateListItem(data.id, {
      content: data.content,
      checked: data.checked,
      assignee_profile_id: data.assigneeProfileId !== undefined ? data.assigneeProfileId : data.assignee_profile_id,
      reward: data.reward,
      due_date: data.dueDate !== undefined ? data.dueDate : data.due_date,
      due_time: data.dueTime !== undefined ? data.dueTime : data.due_time,
      recurrence: data.recurrence,
      recurrence_interval: data.recurrenceInterval !== undefined ? data.recurrenceInterval : data.recurrence_interval,
      recurrence_days: data.recurrenceDays !== undefined ? data.recurrenceDays : data.recurrence_days
    });
    io.emit('dashboard_update', getDashboardData());
  });

  // Interactive list item delete from tablet
  socket.on('list:item:delete', ({ id }) => {
    if (!id) return;
    deleteListItem(id);
    io.emit('dashboard_update', getDashboardData());
  });

  // Clear completed items in a list from tablet
  socket.on('list:clear_completed', ({ listId, list_id }) => {
    const targetId = listId || list_id;
    if (!targetId) return;
    clearCompletedListItems(targetId);
    io.emit('dashboard_update', getDashboardData());
  });

  // Notes CRUD from tablet
  socket.on('note:add', ({ content }) => {
    if (!content || !String(content).trim()) return;
    insertNote(String(content).trim());
    io.emit('dashboard_update', getDashboardData());
  });

  socket.on('note:update', ({ id, content }) => {
    if (!id || !content || !String(content).trim()) return;
    updateNote(id, String(content).trim());
    io.emit('dashboard_update', getDashboardData());
  });

  socket.on('note:delete', ({ id }) => {
    if (!id) return;
    deleteNote(id);
    io.emit('dashboard_update', getDashboardData());
  });

  // Meal Menu interactive updates from tablet
  socket.on('meal:slot:set', (payload) => {
    if (!payload || !payload.day || !payload.slot) return;
    setMealSlotEntry({
      menu_id: payload.menu_id || null,
      week_start: payload.week_start || null,
      day: payload.day,
      slot: payload.slot,
      entries: payload.entries || []
    });
    io.emit('dashboard_update', getDashboardData());
  });

  socket.on('meal:ingredients:to_shopping', (payload) => {
    if (!payload) return;
    let ingredients = Array.isArray(payload.ingredients) ? payload.ingredients : [];
    if (!ingredients.length && payload.dish_id) {
      const dish = getDishById(payload.dish_id);
      if (dish && Array.isArray(dish.ingredients)) ingredients = dish.ingredients;
    }
    if (ingredients.length) {
      addIngredientsToShoppingList(ingredients, payload.assignee_profile_id || null);
      io.emit('dashboard_update', getDashboardData());
    }
  });

  // Save widget layouts from kiosk (with optional profileId)
  socket.on('layout:save', (data) => {
    try {
      if (Array.isArray(data)) {
        saveWidgetLayouts(data, null);
      } else if (data && Array.isArray(data.layouts)) {
        saveWidgetLayouts(data.layouts, data.profileId || null);
      }
      io.emit('dashboard_update', getDashboardData());
    } catch (err) {
      console.error('[Socket] Failed to save layout:', err.message);
    }
  });

  // Save page config from kiosk (theme & font_size per page / profile)
  socket.on('page:config:save', (data) => {
    if (data) {
      try {
        const pKey = data.profile_key || (data.profileId ? String(data.profileId) : 'family');
        savePageConfig({
          profile_key: pKey,
          page: Number(data.page) || 0,
          theme: data.theme || 'inherit',
          font_size: data.font_size || 'inherit'
        });
        io.emit('dashboard_update', getDashboardData());
      } catch (err) {
        console.error('[Socket] Failed to save page config:', err.message);
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id} (${reason})`);
  });
});

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Password verification endpoint for Kiosk Edit Mode
app.post('/api/verify-pass', (req, res) => {
  const { password } = req.body;
  const expectedPass = process.env.ADMIN_PASS || 'your_admin_pass';
  if (password && basicAuth.safeCompare(String(password), expectedPass)) {
    return res.json({ ok: true, token: process.env.DASHBOARD_TOKEN || 'your_secret_token' });
  }
  return res.status(401).json({ ok: false, error: 'Incorrect admin password' });
});

// Public Settings endpoint
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

// Express Basic Auth for Admin routes (/admin and /api/admin/*)
const adminAuth = basicAuth({
  authorizer: (username, password) => {
    const expectedPass = process.env.ADMIN_PASS || 'your_admin_pass';
    return basicAuth.safeCompare(password, expectedPass);
  },
  challenge: true,
  realm: 'SmartHomeAdmin'
});

app.use('/admin', adminAuth);
app.use('/api/admin', adminAuth);

// Admin UI routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});
app.use('/admin', express.static(path.join(__dirname, '../admin'), { index: false }));

// Admin API endpoints
app.get('/api/admin/ping', (req, res) => {
  res.json({
    status: 'ok',
    admin: true,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/admin/data', (req, res) => {
  res.json(getDashboardData({ includePrivateSettings: true }));
});

app.get('/api/admin/audit-logs', (req, res) => {
  const { limit, offset, source, status } = req.query;
  const logs = getAuditLogs({
    limit: limit ? Number(limit) : 100,
    offset: offset ? Number(offset) : 0,
    source: source || null,
    status: status || null
  });
  res.json(logs);
});

app.delete('/api/admin/audit-logs', (req, res) => {
  clearAuditLogs();
  res.json({ ok: true });
});

app.post('/api/admin/notes', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const note = insertNote(content);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, note });
});

app.patch('/api/admin/notes/:id', (req, res) => {
  const { content } = req.body;
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
  const note = updateNote(req.params.id, content);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, note });
});

app.delete('/api/admin/notes/:id', (req, res) => {
  deleteNote(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

app.post('/api/admin/tasks', (req, res) => {
  const { title, assignee, reward, status } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const task = insertTask({ title, assignee, reward, status });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, task });
});

app.patch('/api/admin/tasks/:id', (req, res) => {
  const { title, assignee, reward, status, completed_by } = req.body;
  if (title !== undefined || assignee !== undefined || reward !== undefined) {
    const task = updateTask(req.params.id, { title, assignee, reward, status, completed_by });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    io.emit('dashboard_update', getDashboardData());
    return res.json({ ok: true, task });
  }
  updateTaskStatus(req.params.id, status || 'completed', completed_by || 'Admin');
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

app.delete('/api/admin/tasks/:id', (req, res) => {
  deleteTask(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// Profiles API
app.get('/api/admin/profiles', (req, res) => {
  res.json(getProfiles());
});

app.post('/api/admin/profiles', (req, res) => {
  const { name, color, avatar_type, avatar_value, telegram_id, theme, font_size, language, librus_login, librus_password } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const profile = insertProfile({ name, color, avatar_type, avatar_value, telegram_id, theme, font_size, language, librus_login, librus_password });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, profile });
});

app.patch('/api/admin/profiles/:id', (req, res) => {
  const profile = updateProfile(req.params.id, req.body);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, profile });
});

app.delete('/api/admin/profiles/:id', (req, res) => {
  deleteProfile(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// Schedules API
app.get('/api/admin/schedules', (req, res) => {
  res.json(getSchedules());
});

app.get('/api/admin/librus/status', (req, res) => {
  const profileCount = getProfiles().filter(profile => profile.librus_login && profile.librus_password).length;
  const globalConfigured = Boolean(process.env.LIBRUS_LOGIN && process.env.LIBRUS_PASSWORD);
  const configured = globalConfigured || profileCount > 0;
  res.json({ configured, profileCount, globalConfigured, status: configured ? 'ready' : 'missing_credentials' });
});

app.post('/api/admin/librus/sync', async (req, res) => {
  try {
    const {
      login: incomingLogin,
      password: incomingPassword,
      profile_id = null,
      profile_name = null
    } = req.body || {};

    let login = typeof incomingLogin === 'string' ? incomingLogin.trim() : '';
    let password = typeof incomingPassword === 'string' ? incomingPassword.trim() : '';

    if (profile_id) {
      const profile = getProfileById(profile_id);
      if (profile) {
        login = login || String(profile.librus_login || '').trim();
        password = password || String(profile.librus_password || '').trim();
      }
    }

    if (!login) {
      login = String(process.env.LIBRUS_LOGIN || '').trim();
    }
    if (!password) {
      password = String(process.env.LIBRUS_PASSWORD || '').trim();
    }

    if (!login || !password) {
      return res.status(400).json({
        error: 'Missing Librus credentials. Save them on the selected profile or configure LIBRUS_LOGIN and LIBRUS_PASSWORD as a fallback.'
      });
    }

    const data = await fetchLibrusData({ login, password });
    const timetable = normalizeTimetableData(data.timetable);
    const profile = profile_id ? getProfileById(profile_id) : null;
    const profileLanguage = profile && profile.language ? profile.language : 'en';
    const created = upsertLibrusSchedule({
      profile_id: profile_id || null,
      profile_name: profile_name || (profile && profile.name) || null,
      schedule: timetable
    });

    const saved = saveLibrusData({
      grades: Array.isArray(data.grades) ? data.grades : [],
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
      notification_counts: data.notificationCounts || {},
      messages: Array.isArray(data.messages) ? data.messages : [],
      announcements: Array.isArray(data.announcements) ? data.announcements.map(item => ({ ...item, author: item.author || item.user })) : [],
      sync_errors: Array.isArray(data.errors) ? data.errors : [],
      summary: buildSchoolDaySummary({
        weather: null,
        tasks: [],
        schedule: timetable,
        grades: Array.isArray(data.grades) ? data.grades : [],
        notifications: Array.isArray(data.notifications) ? data.notifications : [],
        announcements: Array.isArray(data.announcements) ? data.announcements.map(item => ({ ...item, author: item.author || item.user })) : [],
        language: profileLanguage
      }),
      timetable,
      account: data.accountInfo || null
    }, profile_id || null);

    insertAuditLog({
      source: 'librus_sync',
      sender_name: profile_name || (profile && profile.name) || 'Librus',
      message_type: 'manual_sync',
      action_taken: `Librus sync: ${timetable.length} weekdays, ${saved.grades.length} grades, ${saved.messages.length} messages, ${saved.announcements.length} announcements`,
      status: data.errors && data.errors.length ? 'partial' : 'success',
      error_message: data.errors && data.errors.length ? JSON.stringify(data.errors) : null
    });

    io.emit('dashboard_update', getDashboardData());

    res.json({
      ok: true,
      schedule: created,
      timetable,
      notifications: saved.notifications || [],
      notificationCounts: saved.notification_counts || {},
      messages: saved.messages || [],
      announcements: saved.announcements || [],
      grades: saved.grades || [],
      errors: saved.sync_errors || [],
      account: saved.account || null,
      summary: saved.summary || ''
    });
  } catch (error) {
    console.error('[Librus] Sync failed:', error.message);
    insertAuditLog({
      source: 'librus_sync',
      sender_name: 'Librus',
      message_type: 'manual_sync',
      action_taken: 'Librus sync failed',
      status: 'error',
      error_message: error.message
    });
    res.status(500).json({ error: error.message || 'Librus sync failed' });
  }
});

app.post('/api/admin/schedules', (req, res) => {
  const { profile_id, name, schedule } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const created = insertSchedule({ profile_id, name, schedule: Array.isArray(schedule) ? schedule : [] });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, schedule: created });
});

app.patch('/api/admin/schedules/:id', (req, res) => {
  const updated = updateSchedule(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Schedule not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, schedule: updated });
});

app.delete('/api/admin/schedules/:id', (req, res) => {
  deleteSchedule(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// Page Config API (admin & kiosk)
app.get('/api/page-configs', (req, res) => {
  res.json(getPageConfigs());
});

app.post('/api/admin/page-config', (req, res) => {
  const { profile_key, profileId, page, theme, font_size } = req.body;
  const pKey = profile_key || (profileId ? String(profileId) : 'family');
  const configs = savePageConfig({
    profile_key: pKey,
    page: Number(page) || 0,
    theme: theme || 'inherit',
    font_size: font_size || 'inherit'
  });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, page_configs: configs });
});

app.post('/api/admin/upload/avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = `/uploads/avatars/${req.file.filename}`;
  res.json({ ok: true, url, filename: req.file.filename });
});

// Lists API
app.get('/api/admin/lists', (req, res) => {
  res.json(getLists());
});

app.post('/api/admin/lists', (req, res) => {
  const { name, type, profile_id, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const list = insertList({ name, type, profile_id, color, icon });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, list });
});

app.patch('/api/admin/lists/:id', (req, res) => {
  const list = updateList(req.params.id, req.body);
  if (!list) return res.status(404).json({ error: 'List not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, list });
});

app.delete('/api/admin/lists/:id', (req, res) => {
  deleteList(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// List items API
app.post('/api/admin/lists/:id/items', (req, res) => {
  const {
    content, assignee_profile_id, reward, position,
    due_date, due_time, recurrence, recurrence_interval, recurrence_days
  } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const item = insertListItem({
    list_id: req.params.id,
    content,
    assignee_profile_id,
    reward,
    position,
    due_date: due_date || null,
    due_time: due_time || null,
    recurrence: recurrence || 'none',
    recurrence_interval: recurrence_interval || 1,
    recurrence_days: recurrence_days || null
  });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, item });
});

app.patch('/api/admin/lists/:listId/items/:itemId', (req, res) => {
  const item = updateListItem(req.params.itemId, req.body);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, item });
});

app.patch('/api/admin/lists/:listId/items/:itemId/toggle', (req, res) => {
  const item = toggleListItemChecked(req.params.itemId, req.body.checked, req.body.completed_by || 'Admin');
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, item });
});

app.post('/api/admin/lists/:listId/clear-completed', (req, res) => {
  const info = clearCompletedListItems(req.params.listId);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, deleted: info.changes });
});

app.delete('/api/admin/lists/:listId/items/:itemId', (req, res) => {
  deleteListItem(req.params.itemId);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// Layouts API
app.get('/api/layouts', (req, res) => {
  const profileId = req.query.profileId ? Number(req.query.profileId) : null;
  res.json(getWidgetLayouts(profileId));
});

app.post('/api/admin/layouts', (req, res) => {
  const { layouts, profileId } = req.body;
  if (!Array.isArray(layouts)) return res.status(400).json({ error: 'layouts must be an array' });
  const saved = saveWidgetLayouts(layouts, profileId || null);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, layouts: saved });
});

// Settings API (admin)
app.post('/api/admin/settings', (req, res) => {
  const updated = updateSettings(req.body);
  const weatherKeys = ['weather_lat', 'weather_lon', 'weather_city', 'weather_units'];
  if (weatherKeys.some(k => req.body[k] !== undefined)) {
    clearWeatherCache();
  }
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, settings: updated });
});

// HTTPS Status & Self-Signed Certificate Generator API (admin)
app.get('/api/admin/https/status', (req, res) => {
  const currentSettings = getSettings();
  const certP = currentSettings.https_cert_path || '';
  const keyP = currentSettings.https_key_path || '';
  res.json({
    activeHttps,
    https_enabled: Boolean(Number(currentSettings.https_enabled || 0)),
    https_port: Number(currentSettings.https_port || 443),
    cert_path: certP,
    key_path: keyP,
    cert_exists: Boolean(certP && fs.existsSync(certP)),
    key_exists: Boolean(keyP && fs.existsSync(keyP))
  });
});

app.post('/api/admin/https/generate-self-signed', (req, res) => {
  try {
    const { execFileSync } = require('child_process');
    const domain = String(req.body?.domain || 'localhost').trim().replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost';
    const certsDir = path.join(__dirname, '../certs');
    if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });
    const certFile = path.join(certsDir, 'fullchain.pem');
    const keyFile = path.join(certsDir, 'privkey.pem');

    execFileSync('openssl', [
      'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
      '-days', '365',
      '-keyout', keyFile,
      '-out', certFile,
      '-subj', `/CN=${domain}`,
      '-addext', `subjectAltName=DNS:${domain},DNS:localhost,IP:127.0.0.1`
    ], { stdio: 'pipe' });

    try { fs.chmodSync(keyFile, 0o600); } catch (e) {}

    const updated = updateSettings({
      https_cert_path: certFile,
      https_key_path: keyFile
    });
    io.emit('dashboard_update', getDashboardData());
    res.json({
      ok: true,
      domain,
      cert_path: certFile,
      key_path: keyFile,
      settings: updated
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to generate certificate: ${err.message}` });
  }
});

app.get('/api/admin/scheduled-subscriptions', (req, res) => {
  res.json(getScheduledSubscriptions());
});

app.post('/api/admin/scheduled-subscriptions', (req, res) => {
  const { profile_id, subscriptions } = req.body || {};
  if (!getProfileById(profile_id)) return res.status(404).json({ error: 'Profile not found' });
  if (!Array.isArray(subscriptions)) return res.status(400).json({ error: 'subscriptions must be an array' });
  const currentSubscriptions = getScheduledSubscriptions();
  const profileLibrus = getLibrusData(profile_id);
  const latestMessageId = (profileLibrus.messages || []).reduce((latest, message) => Math.max(latest, Number(message.id) || 0), 0) || null;
  for (const item of subscriptions) {
    if (!SUBSCRIPTION_TYPES.has(item.type)) return res.status(400).json({ error: `Unsupported subscription type: ${item.type}` });
    const exists = currentSubscriptions.some(record => Number(record.profile_id) === Number(profile_id) && record.type === item.type);
    upsertScheduledSubscription({ profile_id, type: item.type, send_time: item.send_time, enabled: item.enabled, initial_cursor: item.type === 'librus_messages' && !exists ? latestMessageId : null });
  }
  insertAuditLog({ source: 'scheduled_job', sender_name: 'Admin Console', message_type: 'subscription_change', action_taken: `Updated scheduled subscriptions for profile ${profile_id}`, status: 'success' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, subscriptions: getScheduledSubscriptions() });
});

// Gemini Models API (admin)
app.get('/api/admin/gemini/models', async (req, res) => {
  try {
    const models = await listAvailableGeminiModels();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/weather/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);
    const results = await searchCity(q.trim());
    res.json(results);
  } catch (err) {
    console.error('Weather search error:', err);
    res.json([]);
  }
});

// Photos API (admin)
app.get('/api/admin/photos', (req, res) => {
  res.json(getPhotos());
});

app.post('/api/admin/upload/photo', uploadPhoto.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const { caption, show_in_screensaver } = req.body;
    const derivative = await createScreensaverDerivative(req.file.path, req.file.filename);
    if (derivative.optimized) await require('fs').promises.unlink(req.file.path).catch(() => {});
    const photo = insertPhoto({ filename: derivative.filename, original_name: req.file.originalname, source: 'upload', caption: caption || null, show_in_screensaver: show_in_screensaver !== '0' });
    io.emit('dashboard_update', getDashboardData());
    res.json({ ok: true, url: `/uploads/photos/${derivative.filename}`, photo });
  } catch (error) {
    await require('fs').promises.unlink(req.file.path).catch(() => {});
    insertAuditLog({ source: 'photo_processing', action_taken: 'Single photo derivative failed', status: 'error', error_message: error.message });
    res.status(500).json({ error: `Photo processing failed: ${error.message}` });
  }
});

// Multi-photo upload API (batch upload up to 50 photos)
app.post('/api/admin/upload/photos', uploadPhoto.array('photos', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No images uploaded' });
  const { caption, show_in_screensaver } = req.body;
  try {
    const insertedPhotos = [];
    for (const file of req.files) {
      const derivative = await createScreensaverDerivative(file.path, file.filename);
      if (derivative.optimized) await require('fs').promises.unlink(file.path).catch(() => {});
      insertedPhotos.push(insertPhoto({ filename: derivative.filename, original_name: file.originalname, source: 'upload', caption: caption || null, show_in_screensaver: show_in_screensaver !== '0' }));
    }
    io.emit('dashboard_update', getDashboardData());
    res.json({ ok: true, count: insertedPhotos.length, photos: insertedPhotos });
  } catch (error) {
    await Promise.all(req.files.map(file => require('fs').promises.unlink(file.path).catch(() => {})));
    insertAuditLog({ source: 'photo_processing', action_taken: 'Batch photo derivative failed', status: 'error', error_message: error.message });
    res.status(500).json({ error: `Photo processing failed: ${error.message}` });
  }
});

app.patch('/api/admin/photos/:id', (req, res) => {
  const photo = updatePhoto(req.params.id, req.body);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, photo });
});

app.delete('/api/admin/photos/:id', (req, res) => {
  const photo = require('./db').getPhotoById(req.params.id);
  if (photo) {
    const filePath = path.join(__dirname, '../public/uploads/photos', photo.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  deletePhoto(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// Public photos endpoint (token-guarded for kiosk)
app.get('/api/photos', (req, res) => {
  const expectedToken = process.env.DASHBOARD_TOKEN || 'your_secret_token';
  if (req.query.token !== expectedToken) return res.status(403).json({ error: 'Forbidden' });
  res.json(getPhotos({ screensaverOnly: true }));
});

app.get('/uploads/photos/:filename', (req, res, next) => {
  if (!/^screen-[a-zA-Z0-9_-]+\.jpg$/.test(req.params.filename)) return next();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, '../public/uploads/photos', req.params.filename), (error) => {
    if (error && !res.headersSent) res.status(error.statusCode || 404).end();
  });
});

// Calendar API (admin)
app.get('/api/admin/calendar/feeds', (req, res) => {
  res.json(getCalendarFeeds());
});

app.post('/api/admin/calendar/feeds', async (req, res) => {
  let { name, ical_url, color, profile_id } = req.body;
  if (!name || !ical_url) return res.status(400).json({ error: 'name and ical_url are required' });
  ical_url = normalizeCalendarUrl(ical_url);
  const feed = insertCalendarFeed({ name, ical_url, color, profile_id });

  let count = 0;
  let warning = null;
  try {
    count = await syncFeed(feed);
    if (count === 0) {
      warning = 'Calendar feed added, but 0 events were found. If this is a private Google Calendar (like a Family group), please use the "Secret address in iCal format" (.ics) from Google Calendar Settings > Integrate calendar.';
    }
  } catch (e) {
    warning = `Initial sync failed: ${e.message}. Please verify the iCal URL (.ics).`;
  }

  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, feed, count, warning });
});

app.delete('/api/admin/calendar/feeds/:id', (req, res) => {
  deleteCalendarFeed(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

app.post('/api/admin/calendar/sync', async (req, res) => {
  try {
    const result = await syncAllFeeds(io);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/calendar/clean-past', (req, res) => {
  try {
    const days = parseInt(req.body?.days, 10) || 1;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const info = deleteOldCalendarEvents(cutoff);
    io.emit('dashboard_update', getDashboardData());
    res.json({ ok: true, deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/calendar/events', (req, res) => {
  const fromDate = req.query.from || null;
  res.json(getCalendarEvents({ fromDate, limit: 500 }));
});

app.post('/api/admin/calendar/events', (req, res) => {
  const { title, description, start_datetime, end_datetime, all_day, profile_id, color } = req.body;
  if (!title || !start_datetime) return res.status(400).json({ error: 'title and start_datetime are required' });
  const event = insertCalendarEvent({
    title,
    description,
    start_datetime,
    end_datetime,
    all_day,
    profile_id,
    color,
    source: 'manual'
  });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, event });
});

app.patch('/api/admin/calendar/events/:id', (req, res) => {
  const event = updateCalendarEvent(req.params.id, req.body);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, event });
});

app.delete('/api/admin/calendar/events/:id', (req, res) => {
  deleteCalendarEvent(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// Dishes & Meal Menus (Menu of the Week) API (admin)
app.get('/api/admin/dishes', (req, res) => {
  const { tag, search } = req.query;
  res.json(getDishes({ tag: tag || null, search: search || null }));
});

app.post('/api/admin/upload/dish-photo', uploadPhoto.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const derivative = await createScreensaverDerivative(req.file.path, req.file.filename);
    if (derivative.optimized) await fs.promises.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, filename: derivative.filename, url: `/uploads/photos/${derivative.filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/dishes', (req, res) => {
  try {
    const { name, photo_filename, ingredients, recipe, tags } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Dish name is required' });
    const dish = insertDish({ name, photo_filename, ingredients, recipe, tags });
    io.emit('dashboard_update', getDashboardData());
    res.json({ ok: true, dish });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/dishes/:id', (req, res) => {
  try {
    const dish = updateDish(req.params.id, req.body || {});
    if (!dish) return res.status(404).json({ error: 'Dish not found' });
    io.emit('dashboard_update', getDashboardData());
    res.json({ ok: true, dish });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/dishes/:id', (req, res) => {
  deleteDish(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

app.get('/api/admin/meal-menus', (req, res) => {
  res.json(getMealMenus());
});

app.post('/api/admin/meal-menus', (req, res) => {
  try {
    const menu = insertMealMenu(req.body || {});
    io.emit('dashboard_update', getDashboardData());
    res.json({ ok: true, menu });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/meal-menus/:id', (req, res) => {
  try {
    const menu = updateMealMenu(req.params.id, req.body || {});
    if (!menu) return res.status(404).json({ error: 'Meal menu not found' });
    io.emit('dashboard_update', getDashboardData());
    res.json({ ok: true, menu });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/meal-menus/:id', (req, res) => {
  deleteMealMenu(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

app.post('/api/admin/meal-menus/:id/apply-template', (req, res) => {
  const menu = applyMealMenuTemplate(req.params.id, req.body || {});
  if (!menu) return res.status(404).json({ error: 'Template not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, menu });
});

app.post('/api/admin/meal-menus/slot', (req, res) => {
  const { menu_id, week_start, day, slot, entries } = req.body || {};
  if (!day || !slot) return res.status(400).json({ error: 'day and slot are required' });
  const menu = setMealSlotEntry({ menu_id, week_start, day, slot, entries });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, menu });
});

app.post('/api/admin/meal-menus/add-to-shopping', (req, res) => {
  const { dish_id, menu_id, day, ingredients } = req.body || {};
  let toAdd = Array.isArray(ingredients) ? [...ingredients] : [];
  if (dish_id) {
    const dish = getDishById(dish_id);
    if (dish && Array.isArray(dish.ingredients)) toAdd.push(...dish.ingredients);
  }
  if (menu_id) {
    const menu = getMealMenuById(menu_id);
    if (menu && menu.schedule) {
      const allDishesById = Object.fromEntries(getDishes().map(d => [String(d.id), d]));
      const daysToScan = day ? [day] : Object.keys(menu.schedule);
      for (const dKey of daysToScan) {
        const daySlots = menu.schedule[dKey] || {};
        for (const entries of Object.values(daySlots)) {
          for (const entry of (Array.isArray(entries) ? entries : [])) {
            if (entry && entry.dish_id && allDishesById[String(entry.dish_id)]) {
              toAdd.push(...(allDishesById[String(entry.dish_id)].ingredients || []));
            }
          }
        }
      }
    }
  }
  const uniqueIngredients = [...new Set(toAdd.map(i => String(i || '').trim()).filter(Boolean))];
  const added = addIngredientsToShoppingList(uniqueIngredients);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, count: added.length, items: added });
});

// Public calendar events endpoint (token-guarded for kiosk)
app.get('/api/calendar/events', (req, res) => {
  const expectedToken = process.env.DASHBOARD_TOKEN || 'your_secret_token';
  if (req.query.token !== expectedToken) return res.status(403).json({ error: 'Forbidden' });
  // fromDate defaults to yesterday in getCalendarEvents; can be overridden with ?from=YYYY-MM-DD
  const fromDate = req.query.from;
  const events = getCalendarEvents({ profileId: req.query.profileId, fromDate });
  res.json(events);
});

app.post('/api/admin/simulate-message', async (req, res) => {
  const { text, senderName } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const effectiveSender = senderName || 'Admin Console';
  try {
    const parsed = await parseTextWithGemini(text, effectiveSender);
    const { updatedData, summary } = await applyParsedGeminiActions(parsed, null, io);
    insertAuditLog({
      source: 'admin_simulator',
      sender_id: 'admin',
      sender_name: effectiveSender,
      message_type: 'simulate',
      raw_input: text,
      parsed_payload: parsed,
      action_taken: summary,
      status: 'success'
    });
    res.json({ ok: true, parsed, data: updatedData });
  } catch (err) {
    insertAuditLog({
      source: 'admin_simulator',
      sender_id: 'admin',
      sender_name: effectiveSender,
      message_type: 'simulate',
      raw_input: text,
      action_taken: 'Simulation failed',
      status: 'error',
      error_message: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Root route /: check if req.query.token === process.env.DASHBOARD_TOKEN. If not, return 403.
app.get('/', (req, res) => {
  const expectedToken = process.env.DASHBOARD_TOKEN || 'your_secret_token';
  const queryToken = req.query.token;

  if (queryToken !== expectedToken) {
    return res.status(403).send('403 Forbidden: Invalid or missing dashboard token');
  }

  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Static file serving for public directory (CSS, JS, assets)
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

// Weather endpoint for kiosk tablet
app.get('/api/weather', async (req, res) => {
  try {
    const weather = await getWeather();
    res.json(weather);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to simulate or inject an incoming text message (useful for webhooks or testing)
app.post('/api/message', async (req, res) => {
  const { senderId, text, token, senderName } = req.body;
  const expectedToken = process.env.DASHBOARD_TOKEN || 'your_secret_token';

  if (token !== expectedToken && req.query.token !== expectedToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Whitelist check if senderId is provided
  const whitelist = (process.env.TELEGRAM_WHITELIST_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (senderId && whitelist.length > 0 && !whitelist.includes(String(senderId))) {
    insertAuditLog({
      source: 'kiosk_dictation',
      sender_id: String(senderId),
      sender_name: senderName || 'Unknown',
      message_type: 'text',
      raw_input: text,
      action_taken: 'Blocked by whitelist',
      status: 'blocked',
      error_message: 'Sender ID not in whitelist'
    });
    return res.status(403).json({ error: 'Sender ID not in whitelist' });
  }

  try {
    const senderProfile = senderId ? getProfileByTelegramId(senderId) : null;
    const effectiveSenderName = senderProfile ? senderProfile.name : (senderName || 'Tablet Kiosk');
    const parsed = await parseTextWithGemini(text, effectiveSenderName);
    const { updatedData, summary } = await applyParsedGeminiActions(parsed, senderProfile, io);

    insertAuditLog({
      source: 'kiosk_dictation',
      sender_id: senderId ? String(senderId) : 'kiosk',
      sender_name: effectiveSenderName,
      message_type: 'text',
      raw_input: text,
      parsed_payload: parsed,
      action_taken: summary,
      status: 'success'
    });

    res.json({
      success: true,
      parsed,
      dashboardData: updatedData
    });
  } catch (err) {
    insertAuditLog({
      source: 'kiosk_dictation',
      sender_id: senderId ? String(senderId) : 'kiosk',
      sender_name: senderName || 'Tablet Kiosk',
      message_type: 'text',
      raw_input: text,
      action_taken: 'Dictation parsing failed',
      status: 'error',
      error_message: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Start background calendar sync cron (15 min)
startCalendarSyncCron(io);

// Initialize Telegraf Bot
const bot = initBot(io);

async function syncConfiguredLibrusProfiles(syncKeys = ['librus_sync_timetable', 'librus_sync_grades', 'librus_sync_notifications', 'librus_sync_announcements', 'librus_sync_messages']) {
  const configuredProfiles = getProfiles().filter(profile => profile.librus_login && profile.librus_password);
  const candidates = configuredProfiles.length
    ? configuredProfiles
    : (process.env.LIBRUS_LOGIN && process.env.LIBRUS_PASSWORD ? [{ id: null, name: 'Family', language: getSettings().language, librus_login: process.env.LIBRUS_LOGIN, librus_password: process.env.LIBRUS_PASSWORD }] : []);
  if (!candidates.length) throw new Error('No Librus profile credentials or global credentials are configured');

  const errors = [];
  for (const profile of candidates) {
    try {
      const data = await fetchLibrusData({ login: profile.librus_login, password: profile.librus_password, resources: syncKeys.map(key => key.replace('librus_sync_', '')) });
      const timetable = normalizeTimetableData(data.timetable);
      const existingData = getLibrusData(profile.id);
      const sections = new Set(syncKeys);
      const dueResources = new Set();
      if (sections.has('librus_sync_timetable')) dueResources.add('timetable');
      if (sections.has('librus_sync_grades')) { dueResources.add('grades'); dueResources.add('grade_detail'); }
      if (sections.has('librus_sync_notifications')) dueResources.add('notification_counts');
      if (sections.has('librus_sync_messages')) { dueResources.add('inbox'); dueResources.add('message_detail'); }
      if (sections.has('librus_sync_announcements')) dueResources.add('announcements');
      const relevantErrors = data.errors.filter(error => dueResources.has(error.resource));
      if (sections.has('librus_sync_timetable')) {
        upsertLibrusSchedule({ profile_id: profile.id, profile_name: profile.name, schedule: timetable });
      }
      const saved = saveLibrusData({
        ...existingData,
        grades: sections.has('librus_sync_grades') ? data.grades : existingData.grades,
        notifications: sections.has('librus_sync_notifications') ? data.notifications : existingData.notifications,
        notification_counts: sections.has('librus_sync_notifications') ? data.notificationCounts : existingData.notification_counts,
        messages: sections.has('librus_sync_messages') ? data.messages : existingData.messages,
        announcements: sections.has('librus_sync_announcements') ? data.announcements.map(item => ({ ...item, author: item.author || item.user })) : existingData.announcements,
        sync_errors: relevantErrors,
        timetable: sections.has('librus_sync_timetable') ? timetable : existingData.timetable,
        account: data.accountInfo,
        summary: buildSchoolDaySummary({ schedule: sections.has('librus_sync_timetable') ? timetable : existingData.timetable, grades: sections.has('librus_sync_grades') ? data.grades : existingData.grades, notifications: sections.has('librus_sync_notifications') ? data.notifications : existingData.notifications, announcements: sections.has('librus_sync_announcements') ? data.announcements : existingData.announcements, language: profile.language })
      }, profile.id || null);
      insertAuditLog({
        source: 'librus_sync',
        sender_name: profile.name || 'Librus',
        message_type: 'scheduled_sync',
        action_taken: `Scheduled sync saved ${saved.grades.length} grades, ${saved.messages.length} messages, ${saved.announcements.length} announcements`,
        status: relevantErrors.length ? 'partial' : 'success',
        error_message: relevantErrors.length ? JSON.stringify(relevantErrors) : null
      });
    } catch (error) {
      errors.push(`${profile.name || 'Librus'}: ${error.message}`);
      insertAuditLog({ source: 'librus_sync', sender_name: profile.name || 'Librus', message_type: 'scheduled_sync', action_taken: 'Profile Librus sync failed', status: 'error', error_message: error.message });
    }
  }
  if (errors.length === candidates.length) throw new Error(errors.join('; '));
  io.emit('dashboard_update', getDashboardData());
}

const maintenance = createMaintenanceService({
  db,
  bot,
  getSettings,
  updateSettings,
  pruneData,
  getSubscriptions: getScheduledSubscriptions,
  markSubscriptionSent: markScheduledSubscriptionSent,
  getLists,
  getSchedules,
  getLibrusData,
  getWeather: () => getWeather(),
  buildSummary: buildSchoolDaySummary,
  syncLibrus: syncConfiguredLibrusProfiles,
  getPhotos,
  updatePhotoFilename,
  createPhotoDerivative: filename => createScreensaverDerivative(path.join(photosDir, filename), filename),
  removePhotoFile: filename => require('fs').promises.unlink(path.join(photosDir, filename)),
  audit: insertAuditLog
});
maintenance.start();

const PORT = parseInt(process.env.PORT, 10) || 3000;

if (require.main === module) {
  const listenOnPort = enableHttps ? httpsPort : PORT;
  const scheme = enableHttps ? 'https' : 'http';

  if (enableHttps) {
    console.log(`HTTPS enabled using certificate: ${sslCertPath}`);
  } else {
    console.log('HTTPS not enabled. Set HTTPS_CERT_PATH and HTTPS_KEY_PATH to serve TLS/SSL.');
  }

  server.listen(listenOnPort, () => {
    console.log(`==============================================`);
    console.log(`  Smart Home Dashboard Server`);
    console.log(`  Port: ${listenOnPort}`);
    console.log(`  Dashboard URL: ${scheme}://localhost:${listenOnPort}/?token=${process.env.DASHBOARD_TOKEN || 'your_secret_token'}`);
    console.log(`  Admin Panel:   ${scheme}://localhost:${listenOnPort}/admin`);
    console.log(`==============================================`);
  });

  const redirectHttpToHttps = process.env.HTTPS_REDIRECT_HTTP === '1' || Number(liveSettings.https_redirect_http || 0) === 1;
  if (redirectHttpToHttps && enableHttps) {
    http.createServer((req, res) => {
      const target = `https://${req.headers.host || 'localhost'}${req.url}`;
      res.writeHead(301, { Location: target });
      res.end();
    }).listen(PORT, () => {
      console.log(`HTTP redirect active: http://localhost:${PORT} -> https://localhost:${httpsPort}`);
    });
  }
}

module.exports = { app, server, io, bot };
