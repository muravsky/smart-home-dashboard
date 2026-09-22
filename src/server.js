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
  getTasks
} = require('./db');
const { parseTextWithGemini } = require('./services/gemini');
const { getWeather } = require('./services/weather');
const { initBot } = require('./bot');

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

  // Push current notes and tasks upon connection
  socket.emit('dashboard_update', getDashboardData());

  // Interactive task completion from tablet
  socket.on('task:toggle', ({ id, status }) => {
    updateTaskStatus(id, status);
    io.emit('dashboard_update', getDashboardData());
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id} (${reason})`);
  });
});

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.post('/api/admin/simulate-message', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const parsed = await parseTextWithGemini(text);
    for (const note of parsed.notes) insertNote(note);
    for (const task of parsed.tasks) insertTask(task);
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
    const { notes, tasks } = await parseTextWithGemini(text);

    for (const note of notes) {
      insertNote(note);
    }
    for (const task of tasks) {
      insertTask(task);
    }

    const updatedData = getDashboardData();
    io.emit('dashboard_update', updatedData);

    res.json({
      success: true,
      parsed: { notes, tasks },
      dashboardData: updatedData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
