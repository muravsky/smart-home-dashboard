const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/smart_home.db');

// Ensure parent directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignee TEXT,
    title TEXT NOT NULL,
    reward REAL DEFAULT 0,
    status TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#38bdf8',
    avatar_type TEXT DEFAULT 'builtin',
    avatar_value TEXT DEFAULT '🙂',
    telegram_id TEXT,
    theme TEXT DEFAULT 'dark',
    font_size TEXT DEFAULT 'normal',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS page_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_key TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 0,
    theme TEXT DEFAULT 'inherit',
    font_size TEXT DEFAULT 'inherit',
    UNIQUE(profile_key, page)
  );

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'custom',
    profile_id INTEGER,
    color TEXT DEFAULT '#334155',
    icon TEXT DEFAULT '📋',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    checked INTEGER DEFAULT 0,
    assignee_profile_id INTEGER,
    reward REAL DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_profile_id) REFERENCES profiles(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS widget_layouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page INTEGER NOT NULL DEFAULT 0,
    widget_type TEXT NOT NULL,
    x INTEGER NOT NULL DEFAULT 0,
    y INTEGER NOT NULL DEFAULT 0,
    w INTEGER NOT NULL DEFAULT 6,
    h INTEGER NOT NULL DEFAULT 2,
    config TEXT DEFAULT '{}',
    position INTEGER DEFAULT 0,
    profile_id INTEGER,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT,
    source TEXT DEFAULT 'upload',
    caption TEXT,
    show_in_screensaver INTEGER DEFAULT 1,
    telegram_file_id TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS calendar_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ical_url TEXT NOT NULL,
    color TEXT DEFAULT '#38bdf8',
    profile_id INTEGER,
    last_synced DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE,
    feed_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    start_datetime TEXT NOT NULL,
    end_datetime TEXT,
    all_day INTEGER DEFAULT 0,
    profile_id INTEGER,
    color TEXT DEFAULT '#38bdf8',
    source TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (feed_id) REFERENCES calendar_feeds(id) ON DELETE CASCADE,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL
  );
`);

// Non-destructive column migrations for existing databases
try {
  const profCols = db.pragma('table_info(profiles)').map(c => c.name);
  if (!profCols.includes('telegram_id')) {
    db.exec('ALTER TABLE profiles ADD COLUMN telegram_id TEXT');
  }
  if (!profCols.includes('theme')) {
    db.exec("ALTER TABLE profiles ADD COLUMN theme TEXT DEFAULT 'dark'");
  }
  if (!profCols.includes('font_size')) {
    db.exec("ALTER TABLE profiles ADD COLUMN font_size TEXT DEFAULT 'normal'");
  }
} catch (e) {
  console.warn('Migration profiles columns check:', e.message);
}

try {
  const layoutCols = db.pragma('table_info(widget_layouts)').map(c => c.name);
  if (!layoutCols.includes('profile_id')) {
    db.exec('ALTER TABLE widget_layouts ADD COLUMN profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE');
  }
} catch (e) {
  console.warn('Migration widget_layouts profile_id check:', e.message);
}

// Seed default settings if empty
const existingSettingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get();
if (existingSettingsCount.count === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('sleep_timeout', '300');
  insertSetting.run('photo_interval', '8');
  insertSetting.run('night_mode_enabled', '0');
  insertSetting.run('night_mode_start', '22:00');
  insertSetting.run('night_mode_end', '07:00');
  insertSetting.run('screensaver_mode', 'photos');
}

// Seed default layouts if empty
const existingLayouts = db.prepare('SELECT COUNT(*) as count FROM widget_layouts').get();
if (existingLayouts.count === 0) {
  const insertLayoutStmt = db.prepare(`
    INSERT INTO widget_layouts (page, widget_type, x, y, w, h, config, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Page 0: Main Family Hub
  insertLayoutStmt.run(0, 'clock', 0, 0, 12, 2, JSON.stringify({ showSeconds: true, showDate: true }), 0);
  insertLayoutStmt.run(0, 'tasks', 0, 2, 6, 2, JSON.stringify({ title: 'Family Tasks' }), 1);
  insertLayoutStmt.run(0, 'list', 6, 2, 6, 2, JSON.stringify({ title: 'Shopping' }), 2);
  insertLayoutStmt.run(0, 'notes', 0, 4, 12, 2, JSON.stringify({ title: 'Family Notes' }), 3);

  // Page 1: Daily Tools (Weather & Kitchen Timer)
  insertLayoutStmt.run(1, 'weather', 0, 0, 6, 2, JSON.stringify({ title: 'Live Forecast' }), 0);
  insertLayoutStmt.run(1, 'timer', 6, 0, 6, 2, JSON.stringify({ title: 'Kitchen Timer' }), 1);
  insertLayoutStmt.run(1, 'tasks', 0, 2, 12, 2, JSON.stringify({ title: 'Chores Board' }), 2);
}

// Seed default lists if empty
const existingLists = db.prepare('SELECT COUNT(*) as count FROM lists').get();
if (existingLists.count === 0) {
  const insertListStmt = db.prepare('INSERT INTO lists (name, type, profile_id, color, icon) VALUES (?, ?, ?, ?, ?)');
  const insertItemStmt = db.prepare('INSERT INTO list_items (list_id, content, checked, reward) VALUES (?, ?, ?, ?)');

  const taskList = insertListStmt.run('Family Tasks', 'tasks', null, '#38bdf8', '✅');
  insertItemStmt.run(taskList.lastInsertRowid, 'Organize living room bookshelf', 0, 10);
  insertItemStmt.run(taskList.lastInsertRowid, 'Take out recycling bins', 0, 15);

  const shopList = insertListStmt.run('Shopping List', 'shopping', null, '#34d399', '🛒');
  insertItemStmt.run(shopList.lastInsertRowid, 'Fresh whole milk', 0, 0);
  insertItemStmt.run(shopList.lastInsertRowid, 'Organic eggs', 0, 0);
  insertItemStmt.run(shopList.lastInsertRowid, 'Sourdough bread', 1, 0);
}

// Seed sample profiles if empty
const existingProfiles = db.prepare('SELECT COUNT(*) as count FROM profiles').get();
if (existingProfiles.count === 0) {
  const insertProfileStmt = db.prepare('INSERT INTO profiles (name, color, avatar_type, avatar_value) VALUES (?, ?, ?, ?)');
  insertProfileStmt.run('Leo', '#f59e0b', 'builtin', '🦁');
  insertProfileStmt.run('Mia', '#ec4899', 'builtin', '🦄');
}

// Seed sample calendar events if empty
const existingEvents = db.prepare('SELECT COUNT(*) as count FROM calendar_events').get();
if (existingEvents.count === 0) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const insertEventStmt = db.prepare(`
    INSERT INTO calendar_events (title, description, start_datetime, end_datetime, all_day, color, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertEventStmt.run('Family Game Night', 'Board games in living room', `${todayStr}T19:00:00`, `${todayStr}T21:00:00`, 0, '#38bdf8', 'manual');
  insertEventStmt.run('Soccer Practice', 'Community field', `${tomorrowStr}T16:30:00`, `${tomorrowStr}T18:00:00`, 0, '#34d399', 'manual');
}

/* ==========================================================================
   Notes Methods (Backward Compatible)
   ========================================================================== */
function insertNote(content) {
  const stmt = db.prepare('INSERT INTO notes (content, timestamp) VALUES (?, ?)');
  const ts = new Date().toISOString();
  const info = stmt.run(content, ts);
  return { id: info.lastInsertRowid, content, timestamp: ts };
}

function getNotes(limit = 50) {
  return db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT ?').all(limit);
}

function deleteNote(id) {
  return db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}

/* ==========================================================================
   Tasks Methods (Backward Compatible)
   ========================================================================== */
function insertTask({ assignee = null, title, reward = 0, status = 'pending' }) {
  const stmt = db.prepare('INSERT INTO tasks (assignee, title, reward, status) VALUES (?, ?, ?, ?)');
  const info = stmt.run(assignee, title, Number(reward) || 0, status);
  return { id: info.lastInsertRowid, assignee, title, reward: Number(reward) || 0, status };
}

function getTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
}

function updateTaskStatus(id, status) {
  return db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
}

function deleteTask(id) {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

/* ==========================================================================
   Profiles Methods
   ========================================================================== */
function getProfiles() {
  return db.prepare('SELECT * FROM profiles ORDER BY name ASC').all();
}

function getProfileById(id) {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
}

function getProfileByTelegramId(telegramId) {
  if (!telegramId) return null;
  return db.prepare('SELECT * FROM profiles WHERE telegram_id = ?').get(String(telegramId).trim());
}

function insertProfile({ name, color = '#38bdf8', avatar_type = 'builtin', avatar_value = '🙂', telegram_id = null, theme = 'dark', font_size = 'normal' }) {
  const stmt = db.prepare('INSERT INTO profiles (name, color, avatar_type, avatar_value, telegram_id, theme, font_size) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const info = stmt.run(name.trim(), color, avatar_type, avatar_value, telegram_id ? String(telegram_id).trim() : null, theme || 'dark', font_size || 'normal');
  return getProfileById(info.lastInsertRowid);
}

function updateProfile(id, { name, color, avatar_type, avatar_value, telegram_id, theme, font_size }) {
  const current = getProfileById(id);
  if (!current) return null;
  const stmt = db.prepare(`
    UPDATE profiles 
    SET name = ?, color = ?, avatar_type = ?, avatar_value = ?, telegram_id = ?, theme = ?, font_size = ? 
    WHERE id = ?
  `);
  stmt.run(
    name !== undefined ? name.trim() : current.name,
    color !== undefined ? color : current.color,
    avatar_type !== undefined ? avatar_type : current.avatar_type,
    avatar_value !== undefined ? avatar_value : current.avatar_value,
    telegram_id !== undefined ? (telegram_id ? String(telegram_id).trim() : null) : current.telegram_id,
    theme !== undefined ? theme : (current.theme || 'dark'),
    font_size !== undefined ? font_size : (current.font_size || 'normal'),
    id
  );
  return getProfileById(id);
}

function deleteProfile(id) {
  return db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

/* ==========================================================================
   Lists & List Items Methods
   ========================================================================== */
function getLists() {
  const lists = db.prepare(`
    SELECT l.*, p.name as profile_name, p.color as profile_color 
    FROM lists l 
    LEFT JOIN profiles p ON l.profile_id = p.id 
    ORDER BY l.id ASC
  `).all();

  const getItemsStmt = db.prepare(`
    SELECT i.*, p.name as assignee_name, p.color as assignee_color, p.avatar_type as assignee_avatar_type, p.avatar_value as assignee_avatar_value
    FROM list_items i
    LEFT JOIN profiles p ON i.assignee_profile_id = p.id
    WHERE i.list_id = ?
    ORDER BY i.checked ASC, i.position ASC, i.id DESC
  `);

  return lists.map((list) => ({
    ...list,
    items: getItemsStmt.all(list.id)
  }));
}

function getListById(id) {
  const list = db.prepare(`
    SELECT l.*, p.name as profile_name, p.color as profile_color 
    FROM lists l 
    LEFT JOIN profiles p ON l.profile_id = p.id 
    WHERE l.id = ?
  `).get(id);

  if (!list) return null;

  list.items = db.prepare(`
    SELECT i.*, p.name as assignee_name, p.color as assignee_color
    FROM list_items i
    LEFT JOIN profiles p ON i.assignee_profile_id = p.id
    WHERE i.list_id = ?
    ORDER BY i.checked ASC, i.position ASC, i.id DESC
  `).all(id);

  return list;
}

function insertList({ name, type = 'custom', profile_id = null, color = '#334155', icon = '📋' }) {
  const stmt = db.prepare('INSERT INTO lists (name, type, profile_id, color, icon) VALUES (?, ?, ?, ?, ?)');
  const info = stmt.run(name.trim(), type, profile_id || null, color, icon);
  return getListById(info.lastInsertRowid);
}

function updateList(id, { name, color, icon, profile_id }) {
  const current = getListById(id);
  if (!current) return null;
  const stmt = db.prepare(`
    UPDATE lists 
    SET name = ?, color = ?, icon = ?, profile_id = ? 
    WHERE id = ?
  `);
  stmt.run(
    name !== undefined ? name.trim() : current.name,
    color !== undefined ? color : current.color,
    icon !== undefined ? icon : current.icon,
    profile_id !== undefined ? profile_id : current.profile_id,
    id
  );
  return getListById(id);
}

function deleteList(id) {
  return db.prepare('DELETE FROM lists WHERE id = ?').run(id);
}

function insertListItem({ list_id, content, assignee_profile_id = null, reward = 0, position = 0 }) {
  const stmt = db.prepare(`
    INSERT INTO list_items (list_id, content, assignee_profile_id, reward, position)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(list_id, content.trim(), assignee_profile_id || null, Number(reward) || 0, position);
  return db.prepare('SELECT * FROM list_items WHERE id = ?').get(info.lastInsertRowid);
}

function toggleListItemChecked(id, checked) {
  const stmt = db.prepare('UPDATE list_items SET checked = ? WHERE id = ?');
  stmt.run(checked ? 1 : 0, id);
  return db.prepare('SELECT * FROM list_items WHERE id = ?').get(id);
}

function updateListItem(id, { content, checked, assignee_profile_id, reward }) {
  const current = db.prepare('SELECT * FROM list_items WHERE id = ?').get(id);
  if (!current) return null;
  const stmt = db.prepare(`
    UPDATE list_items 
    SET content = ?, checked = ?, assignee_profile_id = ?, reward = ?
    WHERE id = ?
  `);
  stmt.run(
    content !== undefined ? content.trim() : current.content,
    checked !== undefined ? (checked ? 1 : 0) : current.checked,
    assignee_profile_id !== undefined ? assignee_profile_id : current.assignee_profile_id,
    reward !== undefined ? Number(reward) || 0 : current.reward,
    id
  );
  return db.prepare('SELECT * FROM list_items WHERE id = ?').get(id);
}

function deleteListItem(id) {
  return db.prepare('DELETE FROM list_items WHERE id = ?').run(id);
}

/* ==========================================================================
   Widget Layouts Methods
   ========================================================================== */
function getWidgetLayouts(profileId = null) {
  let rows = [];
  if (profileId) {
    rows = db.prepare('SELECT * FROM widget_layouts WHERE profile_id = ? ORDER BY page ASC, position ASC, id ASC').all(profileId);
    if (rows.length === 0) {
      // Fallback to shared family layout (profile_id IS NULL)
      rows = db.prepare('SELECT * FROM widget_layouts WHERE profile_id IS NULL ORDER BY page ASC, position ASC, id ASC').all();
    }
  } else {
    rows = db.prepare('SELECT * FROM widget_layouts WHERE profile_id IS NULL ORDER BY page ASC, position ASC, id ASC').all();
  }

  return rows.map(r => {
    let cfg = {};
    try {
      cfg = JSON.parse(r.config);
    } catch(e) {}
    return {
      ...r,
      config: cfg
    };
  });
}

function getAllProfileLayouts() {
  const rows = db.prepare('SELECT * FROM widget_layouts ORDER BY profile_id ASC, page ASC, position ASC, id ASC').all();
  const byProfile = {};
  for (const r of rows) {
    let cfg = {};
    try { cfg = JSON.parse(r.config); } catch(e) {}
    const pKey = r.profile_id !== null ? String(r.profile_id) : 'family';
    if (!byProfile[pKey]) byProfile[pKey] = [];
    byProfile[pKey].push({
      ...r,
      config: cfg
    });
  }
  return byProfile;
}

function saveWidgetLayouts(layouts, profileId = null) {
  if (!Array.isArray(layouts)) return getWidgetLayouts(profileId);

  const tx = db.transaction((items) => {
    if (profileId) {
      db.prepare('DELETE FROM widget_layouts WHERE profile_id = ?').run(profileId);
    } else {
      db.prepare('DELETE FROM widget_layouts WHERE profile_id IS NULL').run();
    }

    const insertStmt = db.prepare(`
      INSERT INTO widget_layouts (page, widget_type, x, y, w, h, config, position, profile_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      insertStmt.run(
        it.page !== undefined ? Number(it.page) : 0,
        it.widget_type,
        it.x !== undefined ? Number(it.x) : 0,
        it.y !== undefined ? Number(it.y) : 0,
        it.w !== undefined ? Number(it.w) : 6,
        it.h !== undefined ? Number(it.h) : 2,
        typeof it.config === 'object' ? JSON.stringify(it.config) : (it.config || '{}'),
        it.position !== undefined ? Number(it.position) : i,
        profileId || null
      );
    }
  });

  tx(layouts);
  return getWidgetLayouts(profileId);
}

/* ==========================================================================
   Settings Methods
   ========================================================================== */
function getSettings() {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {
    sleep_timeout: 300,
    sleep_timeout_day: 300,
    sleep_timeout_night: 60,
    screensaver_mode: 'photos',
    screensaver_mode_day: 'photos',
    screensaver_mode_night: 'clock',
    photo_interval: 8,
    photo_interval_day: 8,
    photo_interval_night: 15,
    night_mode_enabled: 0,
    night_mode_start: '22:00',
    night_mode_end: '07:00'
  };
  const numericKeys = [
    'sleep_timeout',
    'sleep_timeout_day',
    'sleep_timeout_night',
    'photo_interval',
    'photo_interval_day',
    'photo_interval_night',
    'night_mode_enabled'
  ];
  for (const r of rows) {
    if (numericKeys.includes(r.key)) {
      settings[r.key] = Number(r.value);
    } else {
      settings[r.key] = r.value;
    }
  }
  return settings;
}

function updateSettings(newSettings) {
  const insertOrReplace = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) {
      insertOrReplace.run(k, String(v));
    }
  });
  tx(newSettings);
  return getSettings();
}

/* ==========================================================================
   Photos Methods
   ========================================================================== */
function getPhotos({ screensaverOnly = false } = {}) {
  if (screensaverOnly) {
    return db.prepare('SELECT * FROM photos WHERE show_in_screensaver = 1 ORDER BY uploaded_at DESC').all();
  }
  return db.prepare('SELECT * FROM photos ORDER BY uploaded_at DESC').all();
}

function getPhotoById(id) {
  return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
}

function insertPhoto({ filename, original_name = null, source = 'upload', caption = null, show_in_screensaver = 1, telegram_file_id = null }) {
  const stmt = db.prepare(`
    INSERT INTO photos (filename, original_name, source, caption, show_in_screensaver, telegram_file_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(filename, original_name, source, caption, show_in_screensaver ? 1 : 0, telegram_file_id);
  return getPhotoById(info.lastInsertRowid);
}

function updatePhoto(id, { caption, show_in_screensaver }) {
  const current = getPhotoById(id);
  if (!current) return null;
  const stmt = db.prepare('UPDATE photos SET caption = ?, show_in_screensaver = ? WHERE id = ?');
  stmt.run(
    caption !== undefined ? caption : current.caption,
    show_in_screensaver !== undefined ? (show_in_screensaver ? 1 : 0) : current.show_in_screensaver,
    id
  );
  return getPhotoById(id);
}

function deletePhoto(id) {
  return db.prepare('DELETE FROM photos WHERE id = ?').run(id);
}

/* ==========================================================================
   Calendar Feeds & Events Methods
   ========================================================================== */
function getCalendarFeeds() {
  return db.prepare(`
    SELECT f.*, p.name as profile_name 
    FROM calendar_feeds f 
    LEFT JOIN profiles p ON f.profile_id = p.id 
    ORDER BY f.id ASC
  `).all();
}

function getCalendarFeedById(id) {
  return db.prepare('SELECT * FROM calendar_feeds WHERE id = ?').get(id);
}

function insertCalendarFeed({ name, ical_url, color = '#38bdf8', profile_id = null }) {
  const stmt = db.prepare('INSERT INTO calendar_feeds (name, ical_url, color, profile_id) VALUES (?, ?, ?, ?)');
  const info = stmt.run(name.trim(), ical_url.trim(), color, profile_id || null);
  return getCalendarFeedById(info.lastInsertRowid);
}

function updateCalendarFeedSyncTime(id, last_synced = new Date().toISOString()) {
  db.prepare('UPDATE calendar_feeds SET last_synced = ? WHERE id = ?').run(last_synced, id);
}

function deleteCalendarFeed(id) {
  return db.prepare('DELETE FROM calendar_feeds WHERE id = ?').run(id);
}

function getCalendarEvents({ profileId = null, limit = 100 } = {}) {
  let query = `
    SELECT e.*, p.name as profile_name, p.color as profile_color 
    FROM calendar_events e 
    LEFT JOIN profiles p ON e.profile_id = p.id
  `;
  const params = [];
  if (profileId) {
    query += ' WHERE e.profile_id IS NULL OR e.profile_id = ?';
    params.push(profileId);
  }
  query += ' ORDER BY e.start_datetime ASC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

function insertCalendarEvent({ uid = null, feed_id = null, title, description = null, start_datetime, end_datetime = null, all_day = 0, profile_id = null, color = '#38bdf8', source = 'manual' }) {
  const stmt = db.prepare(`
    INSERT INTO calendar_events (uid, feed_id, title, description, start_datetime, end_datetime, all_day, profile_id, color, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    uid,
    feed_id,
    title.trim(),
    description,
    start_datetime,
    end_datetime,
    all_day ? 1 : 0,
    profile_id || null,
    color,
    source
  );
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(info.lastInsertRowid);
}

function upsertCalendarEventByUid({ uid, feed_id = null, title, description = null, start_datetime, end_datetime = null, all_day = 0, profile_id = null, color = '#38bdf8', source = 'google' }) {
  const stmt = db.prepare(`
    INSERT INTO calendar_events (uid, feed_id, title, description, start_datetime, end_datetime, all_day, profile_id, color, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      start_datetime = excluded.start_datetime,
      end_datetime = excluded.end_datetime,
      all_day = excluded.all_day,
      color = excluded.color
  `);
  stmt.run(
    uid,
    feed_id,
    title.trim(),
    description,
    start_datetime,
    end_datetime,
    all_day ? 1 : 0,
    profile_id || null,
    color,
    source
  );
  return db.prepare('SELECT * FROM calendar_events WHERE uid = ?').get(uid);
}

function deleteCalendarEvent(id) {
  return db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
}

/* ==========================================================================
   Page Configs (Theme & Font Size per page / profile)
   ========================================================================== */
function getPageConfigs() {
  const rows = db.prepare('SELECT * FROM page_configs').all();
  const map = {};
  for (const r of rows) {
    map[`${r.profile_key}_${r.page}`] = {
      profile_key: r.profile_key,
      page: r.page,
      theme: r.theme || 'inherit',
      font_size: r.font_size || 'inherit'
    };
  }
  return map;
}

function savePageConfig({ profile_key = 'family', page = 0, theme = 'inherit', font_size = 'inherit' }) {
  const stmt = db.prepare(`
    INSERT INTO page_configs (profile_key, page, theme, font_size)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_key, page) DO UPDATE SET
      theme = excluded.theme,
      font_size = excluded.font_size
  `);
  stmt.run(String(profile_key), Number(page), theme || 'inherit', font_size || 'inherit');
  return getPageConfigs();
}

/* ==========================================================================
   Unified Dashboard State
   ========================================================================== */
function getDashboardData() {
  return {
    notes: getNotes(),
    tasks: getTasks(),
    profiles: getProfiles(),
    lists: getLists(),
    layouts: getWidgetLayouts(null),
    profile_layouts: getAllProfileLayouts(),
    page_configs: getPageConfigs(),
    photos: getPhotos({ screensaverOnly: true }),
    events: getCalendarEvents({ limit: 50 }),
    feeds: getCalendarFeeds(),
    settings: getSettings()
  };
}

module.exports = {
  db,
  insertNote,
  insertTask,
  deleteNote,
  updateTaskStatus,
  deleteTask,
  getNotes,
  getTasks,
  getProfiles,
  getProfileById,
  getProfileByTelegramId,
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
  getPageConfigs,
  savePageConfig,
  getSettings,
  updateSettings,
  getPhotos,
  getPhotoById,
  insertPhoto,
  updatePhoto,
  deletePhoto,
  getCalendarFeeds,
  getCalendarFeedById,
  insertCalendarFeed,
  updateCalendarFeedSyncTime,
  deleteCalendarFeed,
  getCalendarEvents,
  insertCalendarEvent,
  upsertCalendarEventByUid,
  deleteCalendarEvent,
  getDashboardData
};
