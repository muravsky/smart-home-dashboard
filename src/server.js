require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const basicAuth = require('express-basic-auth');

const {
  insertNote,
  insertTask,
  deleteNote,
  updateTaskStatus,
  deleteTask,
  getDashboardData,
  getNotes,
  getTasks,
  getProfiles,
  getProfileById,
  insertProfile,
  updateProfile,
  deleteProfile,
  getLists,
  getListById,
  insertList,
  updateList,
  deleteList,
  insertListItem,
  toggleListItemChecked,
  updateListItem,
  deleteListItem,
  getWidgetLayouts,
  getAllProfileLayouts,
  saveWidgetLayouts,
  getSettings,
  updateSettings,
  getPhotos,
  insertPhoto,
  updatePhoto,
  deletePhoto,
  getCalendarFeeds,
  insertCalendarFeed,
  deleteCalendarFeed,
  getCalendarEvents,
  insertCalendarEvent,
  deleteCalendarEvent
} = require('./db');
const { parseTextWithGemini } = require('./services/gemini');
const { getWeather } = require('./services/weather');
const { initBot } = require('./bot');
const { uploadAvatar, uploadPhoto } = require('./middleware/upload');
const { syncFeed, syncAllFeeds, startCalendarSyncCron } = require('./services/calendar');

const app = express();
const server = http.createServer(app);

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
  socket.on('task:toggle', ({ id, status }) => {
    updateTaskStatus(id, status);
    io.emit('dashboard_update', getDashboardData());
  });

  // Interactive list item toggle from tablet
  socket.on('list:item:toggle', ({ id, checked }) => {
    toggleListItemChecked(id, checked);
    io.emit('dashboard_update', getDashboardData());
  });

  // Interactive list item addition from tablet
  socket.on('list:item:add', ({ listId, content, assigneeProfileId, reward }) => {
    insertListItem({
      list_id: listId,
      content,
      assignee_profile_id: assigneeProfileId,
      reward
    });
    io.emit('dashboard_update', getDashboardData());
  });

  // Save widget layouts from kiosk (with optional profileId)
  socket.on('layout:save', (data) => {
    if (Array.isArray(data)) {
      saveWidgetLayouts(data, null);
    } else if (data && Array.isArray(data.layouts)) {
      saveWidgetLayouts(data.layouts, data.profileId || null);
    }
    io.emit('dashboard_update', getDashboardData());
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
  res.json(getDashboardData());
});

app.post('/api/admin/notes', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const note = insertNote(content);
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
  const { status } = req.body;
  updateTaskStatus(req.params.id, status || 'completed');
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
  const { name, color, avatar_type, avatar_value, telegram_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const profile = insertProfile({ name, color, avatar_type, avatar_value, telegram_id });
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
  const { content, assignee_profile_id, reward, position } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const item = insertListItem({
    list_id: req.params.id,
    content,
    assignee_profile_id,
    reward,
    position
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
  const item = toggleListItemChecked(req.params.itemId, req.body.checked);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, item });
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
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, settings: updated });
});

// Photos API (admin)
app.get('/api/admin/photos', (req, res) => {
  res.json(getPhotos());
});

app.post('/api/admin/upload/photo', uploadPhoto.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const { caption, show_in_screensaver } = req.body;
  const url = `/uploads/photos/${req.file.filename}`;
  const photo = insertPhoto({
    filename: req.file.filename,
    original_name: req.file.originalname,
    source: 'upload',
    caption: caption || null,
    show_in_screensaver: show_in_screensaver !== '0'
  });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, url, photo });
});

app.patch('/api/admin/photos/:id', (req, res) => {
  const photo = updatePhoto(req.params.id, req.body);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, photo });
});

app.delete('/api/admin/photos/:id', (req, res) => {
  const fs = require('fs');
  const path = require('path');
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

// Calendar API (admin)
app.get('/api/admin/calendar/feeds', (req, res) => {
  res.json(getCalendarFeeds());
});

app.post('/api/admin/calendar/feeds', async (req, res) => {
  const { name, ical_url, color, profile_id } = req.body;
  if (!name || !ical_url) return res.status(400).json({ error: 'name and ical_url are required' });
  const feed = insertCalendarFeed({ name, ical_url, color, profile_id });
  // Initial sync in background
  syncFeed(feed).then(() => io.emit('dashboard_update', getDashboardData())).catch(e => console.warn(e));
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true, feed });
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

app.get('/api/admin/calendar/events', (req, res) => {
  res.json(getCalendarEvents());
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

app.delete('/api/admin/calendar/events/:id', (req, res) => {
  deleteCalendarEvent(req.params.id);
  io.emit('dashboard_update', getDashboardData());
  res.json({ ok: true });
});

// Public calendar events endpoint (token-guarded for kiosk)
app.get('/api/calendar/events', (req, res) => {
  const expectedToken = process.env.DASHBOARD_TOKEN || 'your_secret_token';
  if (req.query.token !== expectedToken) return res.status(403).json({ error: 'Forbidden' });
  const events = getCalendarEvents({ profileId: req.query.profileId });
  res.json(events);
});

app.post('/api/admin/simulate-message', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const parsed = await parseTextWithGemini(text);
    if (parsed.notes) for (const note of parsed.notes) insertNote(note);
    if (parsed.tasks) for (const task of parsed.tasks) insertTask(task);
    if (parsed.shopping_items && parsed.shopping_items.length > 0) {
      const allLists = getLists();
      const shopList = allLists.find(l => l.type === 'shopping') || allLists[0];
      if (shopList) {
        for (const item of parsed.shopping_items) {
          insertListItem({ list_id: shopList.id, content: item.content, reward: 0 });
        }
      }
    }
    if (parsed.calendar_events && parsed.calendar_events.length > 0) {
      for (const ev of parsed.calendar_events) {
        const startIso = ev.time ? `${ev.date}T${ev.time}:00` : `${ev.date}T09:00:00`;
        insertCalendarEvent({ title: ev.title, start_datetime: startIso, all_day: ev.all_day ? 1 : 0, source: 'gemini' });
      }
    }
    if (parsed.timer && parsed.timer.minutes) {
      io.emit('timer:set', { minutes: Number(parsed.timer.minutes), action: parsed.timer.action || 'start' });
    }
    const updated = getDashboardData();
    io.emit('dashboard_update', updated);
    res.json({ ok: true, parsed, data: updated });
  } catch (err) {
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
  const { senderId, text, token } = req.body;
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
    return res.status(403).json({ error: 'Sender ID not in whitelist' });
  }

  try {
    const parsed = await parseTextWithGemini(text);
    if (parsed.notes) for (const note of parsed.notes) insertNote(note);
    if (parsed.tasks) for (const task of parsed.tasks) insertTask(task);
    if (parsed.shopping_items && parsed.shopping_items.length > 0) {
      const allLists = getLists();
      const shopList = allLists.find(l => l.type === 'shopping') || allLists[0];
      if (shopList) {
        for (const item of parsed.shopping_items) {
          insertListItem({ list_id: shopList.id, content: item.content, reward: 0 });
        }
      }
    }
    if (parsed.calendar_events && parsed.calendar_events.length > 0) {
      for (const ev of parsed.calendar_events) {
        const startIso = ev.time ? `${ev.date}T${ev.time}:00` : `${ev.date}T09:00:00`;
        insertCalendarEvent({ title: ev.title, start_datetime: startIso, all_day: ev.all_day ? 1 : 0, source: 'gemini' });
      }
    }
    if (parsed.timer && parsed.timer.minutes) {
      io.emit('timer:set', { minutes: Number(parsed.timer.minutes), action: parsed.timer.action || 'start' });
    }

    const updatedData = getDashboardData();
    io.emit('dashboard_update', updatedData);

    res.json({
      success: true,
      parsed,
      dashboardData: updatedData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start background calendar sync cron (15 min)
startCalendarSyncCron(io);

// Initialize Telegraf Bot
const bot = initBot(io);

const PORT = parseInt(process.env.PORT, 10) || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`==============================================`);
    console.log(`  Smart Home Dashboard Server`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Dashboard URL: http://localhost:${PORT}/?token=${process.env.DASHBOARD_TOKEN || 'your_secret_token'}`);
    console.log(`  Admin Panel:   http://localhost:${PORT}/admin`);
    console.log(`==============================================`);
  });
}

module.exports = { app, server, io, bot };
