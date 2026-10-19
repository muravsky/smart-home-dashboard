const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const crypto = require('crypto');

const SECRET_PREFIX = 'enc:v1:';

function getEncryptionKey() {
  const rawSecret = process.env.CREDENTIALS_SECRET || process.env.DASHBOARD_TOKEN || 'smart-home-default-key';
  return crypto.createHash('sha256').update(String(rawSecret)).digest();
}

function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const str = String(plaintext);
  if (isEncryptedSecret(str)) return str;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(ciphertext) {
  if (ciphertext === null || ciphertext === undefined || ciphertext === '') return null;
  const str = String(ciphertext);
  if (!isEncryptedSecret(str)) return str;
  try {
    const body = str.slice(SECRET_PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split(':');
    if (!ivB64 || !tagB64 || dataB64 === undefined) return str;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (err) {
    return str;
  }
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/smart_home.db');
const SAMPLE_DB_PATH = path.join(__dirname, '../data/samples/smart_home_sample.db');

// Ensure parent directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

function createDatabaseConnection() {
  if (!fs.existsSync(DB_PATH) && fs.existsSync(SAMPLE_DB_PATH)) {
    fs.copyFileSync(SAMPLE_DB_PATH, DB_PATH);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

let db;
try {
  db = createDatabaseConnection();
} catch (error) {
  if (fs.existsSync(SAMPLE_DB_PATH)) {
    console.warn(`Database at ${DB_PATH} is unreadable; restoring from sample DB.`, error.message);
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      const candidate = `${DB_PATH}${suffix}`;
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
    }
    fs.copyFileSync(SAMPLE_DB_PATH, DB_PATH);
    db = createDatabaseConnection();
  } else {
    throw error;
  }
}

function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const fileName of migrationFiles) {
    const version = fileName.replace(/\.sql$/i, '');
    const alreadyApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
    if (alreadyApplied) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  }
}

runMigrations();

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
    language TEXT DEFAULT 'en',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER,
    name TEXT NOT NULL,
    schedule_data TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
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

  CREATE TABLE IF NOT EXISTS librus_data (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS librus_profile_data (
    profile_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (profile_id, key),
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
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

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    sender_id TEXT,
    sender_name TEXT,
    message_type TEXT,
    raw_input TEXT,
    parsed_payload TEXT,
    action_taken TEXT,
    status TEXT DEFAULT 'success',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scheduled_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    send_time TEXT NOT NULL DEFAULT '07:00',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sent_on TEXT,
    last_cursor TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_id, type),
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS dishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo_filename TEXT,
    ingredients TEXT DEFAULT '[]',
    recipe TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meal_menus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_template INTEGER DEFAULT 0,
    week_start TEXT,
    is_active INTEGER DEFAULT 0,
    meal_slots TEXT DEFAULT '["Breakfast","Lunch","Dinner","Snack"]',
    schedule TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    cost INTEGER NOT NULL DEFAULT 50,
    icon TEXT DEFAULT '🎁',
    profile_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reward_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    reward_id INTEGER,
    reward_title TEXT NOT NULL,
    reward_icon TEXT DEFAULT '🎁',
    cost INTEGER NOT NULL DEFAULT 0,
    points_spent INTEGER NOT NULL DEFAULT 0,
    redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
`);

// Non-destructive column migrations for existing databases
try {
  const rewardCols = db.pragma('table_info(rewards)').map(c => c.name);
  if (!rewardCols.includes('profile_id')) db.exec('ALTER TABLE rewards ADD COLUMN profile_id INTEGER');
  const redCols = db.pragma('table_info(reward_redemptions)').map(c => c.name);
  if (!redCols.includes('reward_icon')) db.exec("ALTER TABLE reward_redemptions ADD COLUMN reward_icon TEXT DEFAULT '🎁'");
  if (!redCols.includes('points_spent')) db.exec('ALTER TABLE reward_redemptions ADD COLUMN points_spent INTEGER DEFAULT 0');
} catch (e) {
  console.warn('Migration rewards columns check:', e.message);
}

try {
  const profCols = db.pragma('table_info(profiles)').map(c => c.name);
  if (!profCols.includes('telegram_id')) {
    db.exec('ALTER TABLE profiles ADD COLUMN telegram_id TEXT');
  }
  if (!profCols.includes('librus_login')) {
    db.exec('ALTER TABLE profiles ADD COLUMN librus_login TEXT');
  }
  if (!profCols.includes('librus_password')) {
    db.exec('ALTER TABLE profiles ADD COLUMN librus_password TEXT');
  }
  if (!profCols.includes('theme')) {
    db.exec("ALTER TABLE profiles ADD COLUMN theme TEXT DEFAULT 'dark'");
  }
  if (!profCols.includes('font_size')) {
    db.exec("ALTER TABLE profiles ADD COLUMN font_size TEXT DEFAULT 'normal'");
  }
  if (!profCols.includes('language')) {
    db.exec("ALTER TABLE profiles ADD COLUMN language TEXT DEFAULT 'en'");
  }
  if (!profCols.includes('points_balance')) {
    db.exec('ALTER TABLE profiles ADD COLUMN points_balance INTEGER DEFAULT 0');
  }
  // Encrypt any legacy plaintext librus_password rows at rest
  const rowsWithPass = db.prepare("SELECT id, librus_password FROM profiles WHERE librus_password IS NOT NULL AND librus_password != ''").all();
  const updateEncPass = db.prepare('UPDATE profiles SET librus_password = ? WHERE id = ?');
  for (const r of rowsWithPass) {
    if (!isEncryptedSecret(r.librus_password)) {
      updateEncPass.run(encryptSecret(r.librus_password), r.id);
    }
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

try {
  const itemCols = db.pragma('table_info(list_items)').map(c => c.name);
  if (!itemCols.includes('due_date')) db.exec('ALTER TABLE list_items ADD COLUMN due_date TEXT');
  if (!itemCols.includes('due_time')) db.exec('ALTER TABLE list_items ADD COLUMN due_time TEXT');
  if (!itemCols.includes('recurrence')) db.exec("ALTER TABLE list_items ADD COLUMN recurrence TEXT DEFAULT 'none'");
  if (!itemCols.includes('recurrence_interval')) db.exec('ALTER TABLE list_items ADD COLUMN recurrence_interval INTEGER DEFAULT 1');
  if (!itemCols.includes('recurrence_days')) db.exec('ALTER TABLE list_items ADD COLUMN recurrence_days TEXT');
  if (!itemCols.includes('last_completed_at')) db.exec('ALTER TABLE list_items ADD COLUMN last_completed_at TEXT');
  if (!itemCols.includes('completed_by')) db.exec('ALTER TABLE list_items ADD COLUMN completed_by TEXT');
  if (!itemCols.includes('category')) db.exec('ALTER TABLE list_items ADD COLUMN category TEXT');
} catch (e) {
  console.warn('Migration list_items columns check:', e.message);
}

try {
  const taskCols = db.pragma('table_info(tasks)').map(c => c.name);
  if (!taskCols.includes('completed_by')) db.exec('ALTER TABLE tasks ADD COLUMN completed_by TEXT');
  if (!taskCols.includes('completed_at')) db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
} catch (e) {
  console.warn('Migration tasks columns check:', e.message);
}

try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_page_configs_profile_page ON page_configs(profile_key, page)');
} catch (e) {
  console.warn('Migration page_configs unique index check:', e.message);
}

// Seed default rewards if empty
try {
  const existingRewards = db.prepare('SELECT COUNT(*) as count FROM rewards').get();
  if (existingRewards.count === 0) {
    const insertRewardStmt = db.prepare('INSERT INTO rewards (title, cost, icon) VALUES (?, ?, ?)');
    insertRewardStmt.run('30m Extra Screen Time', 50, '🎮');
    insertRewardStmt.run('Ice Cream Treat', 40, '🍦');
    insertRewardStmt.run('Pick Friday Dinner', 100, '🍕');
    insertRewardStmt.run('Movie Night Choice', 150, '🎬');
  }
} catch (e) {
  console.warn('Seed rewards check:', e.message);
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
  insertSetting.run('language', 'en');
  insertSetting.run('gemini_system_prompt', `You are the smart assistant for a family smart home tablet dashboard. Today is ${new Date().toISOString().slice(0, 10)}.\nAnalyze the user's natural language input and return ONLY raw JSON matching this schema:\n{\n  "notes": ["string of note content"],\n  "tasks": [\n    {\n      "title": "string",\n      "assignee": "string or null",\n      "reward": 0,\n      "due_date": "YYYY-MM-DD or null",\n      "due_time": "HH:MM or null",\n      "recurrence": "none|daily|weekly|weekdays|weekends|interval",\n      "recurrence_interval": 1,\n      "action": "add"\n    }\n  ],\n  "shopping_items": [\n    {\n      "content": "string (e.g. milk, eggs)",\n      "action": "add"\n    }\n  ],\n  "calendar_events": [\n    {\n      "title": "string",\n      "date": "YYYY-MM-DD",\n      "time": "HH:MM or null",\n      "all_day": false\n    }\n  ],\n  "timer": {\n    "action": "start",\n    "minutes": 5\n  },\n  "response_message": "Friendly 1-line confirmation of what was created or done"\n}\n\nRules:\n1. Shopping items: If the user mentions groceries, shopping, buy X, need X, put them in shopping_items.\n2. Calendar events: If user mentions an appointment, meeting, practice, schedule, event with a date or time, put them in calendar_events with accurate ISO date (e.g. tomorrow = calculate relative to today).\n3. Timer: If user says "set timer for 10 minutes", populate timer object (minutes as number).\n4. Tasks: Chores, to-dos, things to do. If reward is mentioned (e.g. "for 15 points"), set reward number. If the user mentions a date or time, fill due_date and due_time. If they say recurring, use recurrence and recurrence_interval.\n5. Notes: Generic info, reminders, thoughts.\n6. Only return non-empty arrays/objects when detected. If a field is not present, use empty array [] or null for timer. If the request is not clearly actionable, return notes with the user text as a reminder.`);
  insertSetting.run('gemini_text_prompt', 'Extract actionable family dashboard items from the message and return only the structured JSON schema described above.');
  insertSetting.run('gemini_voice_prompt', 'Please listen carefully to this voice recording, transcribe it, and extract the smart home actions according to the schema.');
  insertSetting.run('gemini_summary_prompt', 'You are a cheerful school-day helper for a family dashboard. Read the full context and write a short, warm, and relevant summary for the child in the requested language. Include weather, first lesson, required materials, chores/todos, reminders, and school notices only when they are actually present. Do not invent missing facts. Keep it encouraging and human, like a caring parent or teacher. Return plain text only, no JSON, no markdown.');
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

// Seed sample dishes and weekly meal menu if empty
const existingDishes = db.prepare('SELECT COUNT(*) as count FROM dishes').get();
if (existingDishes.count === 0) {
  const insertDishStmt = db.prepare(`
    INSERT INTO dishes (name, photo_filename, ingredients, recipe, tags)
    VALUES (?, ?, ?, ?, ?)
  `);
  const d1 = insertDishStmt.run(
    'Blueberry Pancakes',
    null,
    JSON.stringify(['Flour', 'Milk', 'Eggs', 'Blueberries', 'Maple syrup']),
    '1. Whisk flour, milk, and eggs into a smooth batter.\n2. Fold in fresh blueberries.\n3. Cook on a buttered griddle until golden on both sides.',
    JSON.stringify(['breakfast', 'sweet', 'kids'])
  ).lastInsertRowid;
  const d2 = insertDishStmt.run(
    'Chicken Caesar Salad',
    null,
    JSON.stringify(['Chicken breast', 'Romaine lettuce', 'Parmesan cheese', 'Croutons', 'Caesar dressing']),
    '1. Season and grill chicken breast until cooked through, then slice.\n2. Toss chopped romaine with dressing, parmesan, and croutons.\n3. Top with warm sliced chicken.',
    JSON.stringify(['lunch', 'healthy', 'quick'])
  ).lastInsertRowid;
  const d3 = insertDishStmt.run(
    'Spaghetti Bolognese',
    null,
    JSON.stringify(['Spaghetti pasta', 'Ground beef', 'Crushed tomatoes', 'Onion', 'Garlic', 'Basil']),
    '1. Brown beef with diced onion and garlic.\n2. Simmer with crushed tomatoes and herbs for 25 minutes.\n3. Serve over al dente spaghetti with grated parmesan.',
    JSON.stringify(['dinner', 'pasta', 'family'])
  ).lastInsertRowid;
  const d4 = insertDishStmt.run(
    'Baked Salmon & Veggies',
    null,
    JSON.stringify(['Salmon fillets', 'Broccoli', 'Carrots', 'Olive oil', 'Lemon']),
    '1. Preheat oven to 200°C.\n2. Arrange salmon and chopped vegetables on a sheet pan.\n3. Drizzle with olive oil and lemon juice; bake for 18 minutes.',
    JSON.stringify(['dinner', 'healthy', 'fish'])
  ).lastInsertRowid;

  const existingMenus = db.prepare('SELECT COUNT(*) as count FROM meal_menus').get();
  if (existingMenus.count === 0) {
    const sampleSchedule = {
      Monday: {
        Breakfast: [{ dish_id: Number(d1), name: 'Blueberry Pancakes' }],
        Lunch: [{ dish_id: Number(d2), name: 'Chicken Caesar Salad' }],
        Dinner: [{ dish_id: Number(d3), name: 'Spaghetti Bolognese' }],
        Snack: [{ dish_id: null, name: 'Apple slices & peanut butter' }]
      },
      Tuesday: {
        Breakfast: [{ dish_id: null, name: 'Oatmeal with berries' }],
        Lunch: [{ dish_id: Number(d2), name: 'Chicken Caesar Salad' }],
        Dinner: [{ dish_id: Number(d4), name: 'Baked Salmon & Veggies' }],
        Snack: [{ dish_id: null, name: 'Greek yogurt' }]
      }
    };
    db.prepare(`
      INSERT INTO meal_menus (name, is_template, week_start, is_active, meal_slots, schedule)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'Family Weekly Menu',
      0,
      null,
      1,
      JSON.stringify(['Breakfast', 'Lunch', 'Dinner', 'Snack']),
      JSON.stringify(sampleSchedule)
    );
  }
}

/* ==========================================================================
   Notes Methods (Backward Compatible)
   ========================================================================== */
function insertNote(content) {
  const stmt = db.prepare('INSERT INTO notes (content, timestamp) VALUES (?, ?)');
  const ts = new Date().toISOString();
  const info = stmt.run(String(content || '').trim(), ts);
  return { id: info.lastInsertRowid, content: String(content || '').trim(), timestamp: ts };
}

function getNotes(limit = 50) {
  return db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT ?').all(limit);
}

function getNoteById(id) {
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
}

function updateNote(id, content) {
  const current = getNoteById(id);
  if (!current) return null;
  const cleanContent = content !== undefined ? String(content).trim() : current.content;
  if (!cleanContent) return current;
  db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(cleanContent, id);
  return getNoteById(id);
}

function deleteNote(id) {
  return db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}

/* ==========================================================================
   Tasks Methods (Backward Compatible)
   ========================================================================== */
function insertTask({ assignee = null, title, reward = 0, status = 'pending' }) {
  const stmt = db.prepare('INSERT INTO tasks (assignee, title, reward, status) VALUES (?, ?, ?, ?)');
  const info = stmt.run(assignee, String(title || '').trim(), Number(reward) || 0, status);
  return { id: info.lastInsertRowid, assignee, title: String(title || '').trim(), reward: Number(reward) || 0, status };
}

function getTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
}

function updateTaskStatus(id, status, completedBy = null) {
  const isDone = status === 'done' || status === 'completed';
  const nowIso = isDone ? new Date().toISOString() : null;
  return db.prepare('UPDATE tasks SET status = ?, completed_at = ?, completed_by = ? WHERE id = ?')
    .run(status, nowIso, isDone ? (completedBy || null) : null, id);
}

function updateTask(id, { title, assignee, reward, status, completed_by }) {
  const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!current) return null;
  const nextStatus = status !== undefined ? status : current.status;
  const isDone = nextStatus === 'done' || nextStatus === 'completed';
  const completedAt = isDone ? (current.completed_at || new Date().toISOString()) : null;
  const completedByVal = completed_by !== undefined ? completed_by : (isDone ? current.completed_by : null);
  db.prepare(`
    UPDATE tasks
    SET title = ?, assignee = ?, reward = ?, status = ?, completed_at = ?, completed_by = ?
    WHERE id = ?
  `).run(
    title !== undefined ? String(title).trim() : current.title,
    assignee !== undefined ? assignee : current.assignee,
    reward !== undefined ? (Number(reward) || 0) : current.reward,
    nextStatus,
    completedAt,
    completedByVal,
    id
  );
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function deleteTask(id) {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

/* ==========================================================================
   Profiles Methods
   ========================================================================== */
function normalizeProfileRow(row) {
  if (!row) return null;
  return {
    ...row,
    points_balance: Number(row.points_balance) || 0,
    librus_password: row.librus_password ? decryptSecret(row.librus_password) : null
  };
}

function getRawProfileById(id) {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
}

function getProfiles() {
  return db.prepare('SELECT * FROM profiles ORDER BY name ASC').all().map(normalizeProfileRow);
}

function getProfileById(id) {
  return normalizeProfileRow(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}

function getProfileByTelegramId(telegramId) {
  if (!telegramId) return null;
  return normalizeProfileRow(db.prepare('SELECT * FROM profiles WHERE telegram_id = ?').get(String(telegramId).trim()));
}

function insertProfile({ name, color = '#38bdf8', avatar_type = 'builtin', avatar_value = '🙂', telegram_id = null, theme = 'dark', font_size = 'normal', language = 'en', librus_login = null, librus_password = null, points_balance = 0 }) {
  const stmt = db.prepare('INSERT INTO profiles (name, color, avatar_type, avatar_value, telegram_id, theme, font_size, language, librus_login, librus_password, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const info = stmt.run(
    name.trim(),
    color,
    avatar_type,
    avatar_value,
    telegram_id ? String(telegram_id).trim() : null,
    theme || 'dark',
    font_size || 'normal',
    language || 'en',
    librus_login ? String(librus_login).trim() : null,
    librus_password ? encryptSecret(String(librus_password)) : null,
    Number(points_balance) || 0
  );
  return getProfileById(info.lastInsertRowid);
}

function updateProfile(id, { name, color, avatar_type, avatar_value, telegram_id, theme, font_size, language, librus_login, librus_password, points_balance }) {
  const current = getProfileById(id);
  if (!current) return null;
  const nextPlainPass = librus_password !== undefined ? (librus_password ? String(librus_password) : null) : current.librus_password;
  const stmt = db.prepare(`
    UPDATE profiles 
    SET name = ?, color = ?, avatar_type = ?, avatar_value = ?, telegram_id = ?, theme = ?, font_size = ?, language = ?, librus_login = ?, librus_password = ?, points_balance = ?
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
    language !== undefined ? (language || 'en') : (current.language || 'en'),
    librus_login !== undefined ? (librus_login ? String(librus_login).trim() : null) : current.librus_login,
    nextPlainPass ? encryptSecret(nextPlainPass) : null,
    points_balance !== undefined ? Math.max(0, Number(points_balance) || 0) : (Number(current.points_balance) || 0),
    id
  );
  return getProfileById(id);
}

function addProfilePoints(profileId, delta) {
  if (!profileId || !Number(delta)) return null;
  const current = getProfileById(profileId);
  if (!current) return null;
  const nextPoints = Math.max(0, (Number(current.points_balance) || 0) + Math.round(Number(delta)));
  db.prepare('UPDATE profiles SET points_balance = ? WHERE id = ?').run(nextPoints, Number(profileId));
  return getProfileById(profileId);
}

function deleteProfile(id) {
  return db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

function normalizeLessonItem(lesson, idx) {
  return {
    number: Number(lesson && lesson.number) || idx + 1,
    start: lesson && lesson.start ? String(lesson.start) : '08:30',
    end: lesson && lesson.end ? String(lesson.end) : '09:15',
    name: lesson && lesson.name ? String(lesson.name) : 'Class',
    room: lesson && lesson.room ? String(lesson.room) : '—',
    teacher: lesson && lesson.teacher ? String(lesson.teacher) : null,
    replacementTeacher: lesson && lesson.replacementTeacher ? String(lesson.replacementTeacher) : null,
    replacement: Boolean(lesson && lesson.replacement),
    moved: Boolean(lesson && lesson.moved),
    cancelled: Boolean(lesson && lesson.cancelled),
    flag: lesson && lesson.flag ? String(lesson.flag) : null,
    original: lesson && lesson.original ? lesson.original : null,
    date: lesson && lesson.date ? String(lesson.date) : null
  };
}

function normalizeScheduleArray(schedule) {
  if (!Array.isArray(schedule)) return [];
  return schedule.map((dayEntry) => {
    const lessons = Array.isArray(dayEntry && dayEntry.lessons)
      ? dayEntry.lessons.map(normalizeLessonItem)
      : [];
    const nextLessons = Array.isArray(dayEntry && dayEntry.nextLessons)
      ? dayEntry.nextLessons.map(normalizeLessonItem)
      : null;
    const normalized = {
      day: dayEntry && dayEntry.day ? String(dayEntry.day) : 'Mon',
      lessons
    };
    if (dayEntry && dayEntry.date) normalized.date = String(dayEntry.date);
    if (dayEntry && dayEntry.nextDate) normalized.nextDate = String(dayEntry.nextDate);
    if (nextLessons) normalized.nextLessons = nextLessons;
    return normalized;
  });
}

function getSchedules() {
  const rows = db.prepare(`
    SELECT s.*, p.name as profile_name, p.color as profile_color
    FROM schedules s
    LEFT JOIN profiles p ON s.profile_id = p.id
    ORDER BY s.id DESC
  `).all();

  return rows.map((row) => {
    let schedule = [];
    try {
      const parsed = JSON.parse(row.schedule_data || '[]');
      schedule = normalizeScheduleArray(parsed);
    } catch (e) {
      schedule = [];
    }
    return {
      ...row,
      schedule
    };
  });
}

function getScheduleById(id) {
  const row = db.prepare(`
    SELECT s.*, p.name as profile_name, p.color as profile_color
    FROM schedules s
    LEFT JOIN profiles p ON s.profile_id = p.id
    WHERE s.id = ?
  `).get(id);
  if (!row) return null;
  let schedule = [];
  try {
    schedule = normalizeScheduleArray(JSON.parse(row.schedule_data || '[]'));
  } catch (e) {
    schedule = [];
  }
  return {
    ...row,
    schedule
  };
}

function getProfileSchedules(profileId) {
  return getSchedules().filter((schedule) => schedule.profile_id === Number(profileId));
}

function insertSchedule({ profile_id = null, name, schedule = [] }) {
  const cleanName = (name || 'School Schedule').trim() || 'School Schedule';
  const info = db.prepare('INSERT INTO schedules (profile_id, name, schedule_data) VALUES (?, ?, ?)').run(
    profile_id || null,
    cleanName,
    JSON.stringify(normalizeScheduleArray(schedule))
  );
  return getScheduleById(info.lastInsertRowid);
}

function upsertLibrusSchedule({ profile_id = null, profile_name = null, schedule = [] } = {}) {
  const profileLabel = (profile_name || 'Student').trim() || 'Student';
  const desiredName = `${profileLabel} Librus timetable`;
  const legacyName = 'Librus timetable';
  const rows = db.prepare(`
    SELECT *
    FROM schedules
    WHERE profile_id IS ?
      AND (name = ? OR name = ? OR name LIKE ?)
    ORDER BY id DESC
  `).all(profile_id ?? null, desiredName, legacyName, `${profileLabel}%`);

  const normalizedSchedule = normalizeScheduleArray(schedule);

  if (rows.length > 0) {
    const target = rows[0];
    updateSchedule(target.id, {
      profile_id: profile_id ?? target.profile_id,
      name: desiredName,
      schedule: normalizedSchedule
    });

    for (const duplicate of rows.slice(1)) {
      deleteSchedule(duplicate.id);
    }

    return getScheduleById(target.id);
  }

  return insertSchedule({
    profile_id: profile_id || null,
    name: desiredName,
    schedule: normalizedSchedule
  });
}

function updateSchedule(id, { profile_id, name, schedule }) {
  const current = getScheduleById(id);
  if (!current) return null;
  const stmt = db.prepare('UPDATE schedules SET profile_id = ?, name = ?, schedule_data = ? WHERE id = ?');
  stmt.run(
    profile_id !== undefined ? (profile_id || null) : current.profile_id,
    name !== undefined ? (String(name).trim() || current.name) : current.name,
    JSON.stringify(normalizeScheduleArray(schedule !== undefined ? schedule : current.schedule)),
    id
  );
  return getScheduleById(id);
}

function deleteSchedule(id) {
  return db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
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

function updateList(id, { name, type, color, icon, profile_id }) {
  const current = getListById(id);
  if (!current) return null;
  const stmt = db.prepare(`
    UPDATE lists 
    SET name = ?, type = ?, color = ?, icon = ?, profile_id = ? 
    WHERE id = ?
  `);
  stmt.run(
    name !== undefined ? name.trim() : current.name,
    type !== undefined ? type : current.type,
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

function calculateNextDueDate(currentDueDateStr, recurrence, interval = 1, daysOfWeek = null) {
  let base = currentDueDateStr ? new Date(currentDueDateStr + 'T00:00:00') : new Date();
  if (isNaN(base.getTime())) base = new Date();

  // If the previous due date is in the past (overdue), roll forward starting from today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (base < todayStart) {
    base = todayStart;
  }
  
  const next = new Date(base);
  
  if (recurrence === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === 'weekdays') {
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getDay() === 0 || next.getDay() === 6);
  } else if (recurrence === 'weekends') {
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getDay() !== 0 && next.getDay() !== 6);
  } else if (recurrence === 'interval') {
    const days = Math.max(1, Number(interval) || 1);
    next.setDate(next.getDate() + days);
  } else if (recurrence === 'weekly' || recurrence === 'custom_days') {
    let targetDays = [next.getDay()];
    if (daysOfWeek) {
      let parsed = daysOfWeek;
      if (typeof daysOfWeek === 'string') {
        try { parsed = JSON.parse(daysOfWeek); } catch(e) { parsed = [daysOfWeek]; }
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        targetDays = parsed.map(d => typeof d === 'string' ? (dayMap[d.toLowerCase()] ?? Number(d)) : Number(d));
      }
    }
    let found = false;
    for (let i = 1; i <= 7; i++) {
      const candidate = new Date(next);
      candidate.setDate(candidate.getDate() + i);
      if (targetDays.includes(candidate.getDay())) {
        next.setTime(candidate.getTime());
        found = true;
        break;
      }
    }
    if (!found) {
      next.setDate(next.getDate() + 7);
    }
  } else {
    next.setDate(next.getDate() + 1);
  }
  
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, '0');
  const d = String(next.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function inferShoppingCategory(rawText) {
  const s = String(rawText || '').toLowerCase();
  if (!s) return 'Other';
  if (/milk|egg|cheese|parmesan|mozzarella|yogurt|butter|cream|cottage|sour cream|kefir/.test(s)) return 'Dairy';
  if (/apple|banana|berry|berries|blueberry|strawberry|lemon|lime|orange|lettuce|romaine|spinach|broccoli|carrot|onion|garlic|tomato|potato|cucumber|pepper|avocado|herb|basil|parsley|dill|fruit|veg|salad|mushroom|zucchini/.test(s)) return 'Produce';
  if (/bread|sourdough|bun|roll|crouton|bagel|tortilla|pita|pastry|croissant|muffin/.test(s)) return 'Bakery';
  if (/chicken|beef|pork|salmon|fish|turkey|bacon|sausage|meat|steak|ham|shrimp|tuna|minced/.test(s)) return 'Meat';
  if (/soap|detergent|paper|towel|trash|bag|sponge|battery|batteries|cleaner|toothpaste|shampoo|tissue|foil|wrap/.test(s)) return 'Household';
  if (/flour|sugar|salt|oil|olive|pasta|spaghetti|lasagna|rice|oat|cereal|syrup|maple|sauce|dressing|bean|soup|spice|coffee|tea|honey|nut|peanut|jam|vinegar|ketchup|mustard|mayo|chocolate|snack/.test(s)) return 'Pantry';
  return 'Other';
}

function parseIngredientQuantity(rawText) {
  const clean = String(rawText || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { quantity: null, unit: '', name: '', normKey: '', formatted: '' };

  const unitPattern = '(?:kg|g|mg|ml|l|oz|lb|lbs|tbsp|tsp|cup|cups|pcs|pc|pack|packs|can|cans|bottle|bottles|slice|slices|clove|cloves)?';
  // Pattern 1: Leading quantity, e.g. "2 Eggs", "200g Flour", "3 tbsp Flour"
  const leadMatch = clean.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})\\s+(.+)$`, 'i'));
  if (leadMatch) {
    const qty = parseFloat(leadMatch[1]);
    const unit = (leadMatch[2] || '').toLowerCase();
    const name = leadMatch[3].trim();
    const normKey = name.toLowerCase().replace(/s$/, '');
    return { quantity: qty, unit, name, normKey, style: 'leading' };
  }

  // Pattern 2: Trailing quantity, e.g. "Cottage cheese 400g", "Eggs 2"
  const trailMatch = clean.match(new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})$`, 'i'));
  if (trailMatch) {
    const name = trailMatch[1].trim();
    const qty = parseFloat(trailMatch[2]);
    const unit = (trailMatch[3] || '').toLowerCase();
    const normKey = name.toLowerCase().replace(/s$/, '');
    return { quantity: qty, unit, name, normKey, style: 'trailing' };
  }

  return {
    quantity: null,
    unit: '',
    name: clean,
    normKey: clean.toLowerCase().replace(/s$/, ''),
    style: 'none'
  };
}

function formatIngredientWithQuantity(qty, unit, name, style = 'leading') {
  const rounded = Math.round(qty * 100) / 100;
  const unitStr = unit ? (['g', 'kg', 'mg', 'ml', 'l', 'oz', 'lb'].includes(unit) ? unit : ` ${unit}`) : '';
  if (style === 'trailing') {
    return `${name} ${rounded}${unitStr}`.trim();
  }
  return `${rounded}${unitStr} ${name}`.trim();
}

function insertListItem({ 
  list_id, 
  content, 
  assignee_profile_id = null, 
  reward = 0, 
  position = 0,
  due_date = null,
  due_time = null,
  recurrence = 'none',
  recurrence_interval = 1,
  recurrence_days = null,
  category = null
}) {
  const cleanContent = String(content || '').trim();
  const listRow = db.prepare('SELECT id, type FROM lists WHERE id = ?').get(Number(list_id));
  const resolvedCategory = category || (listRow && listRow.type === 'shopping' ? inferShoppingCategory(cleanContent) : null);

  if (listRow && listRow.type === 'shopping' && cleanContent) {
    // 1. Check exact match first (preserves deduplication & reactivation behavior)
    const existingExact = db.prepare(`
      SELECT * FROM list_items
      WHERE list_id = ? AND LOWER(TRIM(content)) = LOWER(?)
      ORDER BY checked ASC, id DESC
      LIMIT 1
    `).get(Number(list_id), cleanContent);

    if (existingExact) {
      if (existingExact.checked === 1) {
        db.prepare('UPDATE list_items SET checked = 0, category = COALESCE(category, ?), created_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(resolvedCategory, existingExact.id);
      } else if (!existingExact.category && resolvedCategory) {
        db.prepare('UPDATE list_items SET category = ? WHERE id = ?').run(resolvedCategory, existingExact.id);
      }
      return db.prepare('SELECT * FROM list_items WHERE id = ?').get(existingExact.id);
    }

    // 2. Smart quantity merging for quantified ingredients (e.g., "2 Eggs" + "3 Eggs" -> "5 Eggs")
    const incomingParsed = parseIngredientQuantity(cleanContent);
    if (incomingParsed.quantity !== null && incomingParsed.normKey) {
      const uncheckedItems = db.prepare('SELECT * FROM list_items WHERE list_id = ? AND checked = 0').all(Number(list_id));
      for (const candidate of uncheckedItems) {
        const candParsed = parseIngredientQuantity(candidate.content);
        if (candParsed.normKey === incomingParsed.normKey && candParsed.unit === incomingParsed.unit && candParsed.quantity !== null) {
          const mergedQty = candParsed.quantity + incomingParsed.quantity;
          const mergedText = formatIngredientWithQuantity(mergedQty, incomingParsed.unit, candParsed.name || incomingParsed.name, candParsed.style);
          db.prepare('UPDATE list_items SET content = ?, category = COALESCE(category, ?) WHERE id = ?')
            .run(mergedText, resolvedCategory, candidate.id);
          return { ...db.prepare('SELECT * FROM list_items WHERE id = ?').get(candidate.id), merged: true };
        }
      }
    }
  }

  const stmt = db.prepare(`
    INSERT INTO list_items (
      list_id, content, assignee_profile_id, reward, position,
      due_date, due_time, recurrence, recurrence_interval, recurrence_days, category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const recDaysStr = recurrence_days ? (typeof recurrence_days === 'string' ? recurrence_days : JSON.stringify(recurrence_days)) : null;
  const info = stmt.run(
    list_id, 
    cleanContent, 
    assignee_profile_id || null, 
    Number(reward) || 0, 
    position,
    due_date || null,
    due_time || null,
    recurrence || 'none',
    Number(recurrence_interval) || 1,
    recDaysStr,
    resolvedCategory
  );
  return db.prepare('SELECT * FROM list_items WHERE id = ?').get(info.lastInsertRowid);
}

function addIngredientsToShoppingList(rawIngredients = [], assigneeProfileId = null) {
  let shoppingList = getLists().find(l => l.type === 'shopping');
  if (!shoppingList) {
    shoppingList = insertList({ name: 'Shopping List', type: 'shopping', color: '#34d399', icon: '🛒' });
  }
  const results = [];
  for (const raw of rawIngredients) {
    const content = String(raw || '').trim();
    if (!content) continue;
    const item = insertListItem({
      list_id: shoppingList.id,
      content,
      assignee_profile_id: assigneeProfileId || null,
      reward: 0
    });
    results.push(item);
  }
  return results;
}

function toggleListItemChecked(id, checked, completedBy = null) {
  const item = db.prepare(`
    SELECT i.*, p.name as assignee_name
    FROM list_items i
    LEFT JOIN profiles p ON i.assignee_profile_id = p.id
    WHERE i.id = ?
  `).get(id);
  if (!item) return null;

  const actor = completedBy || item.assignee_name || null;
  const rewardPoints = Number(item.reward) || 0;

  let targetProfileId = item.assignee_profile_id ? Number(item.assignee_profile_id) : null;
  if (!targetProfileId && actor) {
    const matchedProf = db.prepare('SELECT id FROM profiles WHERE LOWER(name) = LOWER(?) LIMIT 1').get(String(actor).trim());
    if (matchedProf) targetProfileId = matchedProf.id;
  }

  if (checked && item.recurrence && item.recurrence !== 'none') {
    const nextDate = calculateNextDueDate(item.due_date, item.recurrence, item.recurrence_interval, item.recurrence_days);
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE list_items 
      SET checked = 0, due_date = ?, last_completed_at = ?, completed_by = ?
      WHERE id = ?
    `).run(nextDate, nowIso, actor, id);
    if (rewardPoints > 0 && targetProfileId) {
      addProfilePoints(targetProfileId, rewardPoints);
    }
  } else {
    const nowIso = checked ? new Date().toISOString() : null;
    if (checked) {
      db.prepare('UPDATE list_items SET checked = 1, last_completed_at = ?, completed_by = COALESCE(?, completed_by) WHERE id = ?')
        .run(nowIso, actor, id);
      if (item.checked !== 1 && rewardPoints > 0 && targetProfileId) {
        addProfilePoints(targetProfileId, rewardPoints);
      }
    } else {
      db.prepare('UPDATE list_items SET checked = 0 WHERE id = ?').run(id);
      if (item.checked === 1 && rewardPoints > 0 && targetProfileId) {
        addProfilePoints(targetProfileId, -rewardPoints);
      }
    }
  }

  const updated = db.prepare(`
    SELECT i.*, p.name as assignee_name, p.color as assignee_color, p.avatar_type as assignee_avatar_type, p.avatar_value as assignee_avatar_value
    FROM list_items i
    LEFT JOIN profiles p ON i.assignee_profile_id = p.id
    WHERE i.id = ?
  `).get(id);
  if (updated) {
    updated.completed_at = updated.last_completed_at || null;
  }
  return updated;
}

function updateListItem(id, { 
  content, 
  checked, 
  assignee_profile_id, 
  reward,
  due_date,
  due_time,
  recurrence,
  recurrence_interval,
  recurrence_days,
  completed_by,
  category
}) {
  const current = db.prepare('SELECT * FROM list_items WHERE id = ?').get(id);
  if (!current) return null;
  const nextChecked = checked !== undefined ? (checked ? 1 : 0) : current.checked;
  const lastCompletedAt = (checked !== undefined && checked && !current.checked)
    ? new Date().toISOString()
    : current.last_completed_at;
  const completedByVal = completed_by !== undefined ? completed_by : current.completed_by;
  const nextCategory = category !== undefined ? category : current.category;

  const stmt = db.prepare(`
    UPDATE list_items 
    SET content = ?, checked = ?, assignee_profile_id = ?, reward = ?,
        due_date = ?, due_time = ?, recurrence = ?, recurrence_interval = ?, recurrence_days = ?,
        last_completed_at = ?, completed_by = ?, category = ?
    WHERE id = ?
  `);
  const recDaysStr = recurrence_days !== undefined
    ? (recurrence_days ? (typeof recurrence_days === 'string' ? recurrence_days : JSON.stringify(recurrence_days)) : null)
    : current.recurrence_days;
  stmt.run(
    content !== undefined ? String(content).trim() : current.content,
    nextChecked,
    assignee_profile_id !== undefined ? assignee_profile_id : current.assignee_profile_id,
    reward !== undefined ? Number(reward) || 0 : current.reward,
    due_date !== undefined ? due_date : current.due_date,
    due_time !== undefined ? due_time : current.due_time,
    recurrence !== undefined ? recurrence : current.recurrence,
    recurrence_interval !== undefined ? Number(recurrence_interval) || 1 : current.recurrence_interval,
    recDaysStr,
    lastCompletedAt,
    completedByVal,
    nextCategory,
    id
  );
  return db.prepare(`
    SELECT i.*, p.name as assignee_name, p.color as assignee_color, p.avatar_type as assignee_avatar_type, p.avatar_value as assignee_avatar_value
    FROM list_items i
    LEFT JOIN profiles p ON i.assignee_profile_id = p.id
    WHERE i.id = ?
  `).get(id);
}

function deleteListItem(id) {
  return db.prepare('DELETE FROM list_items WHERE id = ?').run(id);
}

function clearCompletedListItems(listId) {
  return db.prepare('DELETE FROM list_items WHERE list_id = ? AND checked = 1').run(Number(listId));
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
    night_mode_end: '07:00',
    weather_city: '',
    weather_lat: '',
    weather_lon: '',
    weather_units: 'metric',
    language: 'en',
    header_clock_enabled: 1,
    header_weather_enabled: 1,
    header_display_size: 'large',
    default_theme: 'white',
    default_font_size: 'xlarge',
    https_enabled: 0,
    https_cert_path: '/etc/letsencrypt/live/your-domain/fullchain.pem',
    https_key_path: '/etc/letsencrypt/live/your-domain/privkey.pem',
    https_port: 443,
    https_redirect_http: 1,
    notification_items_limit: 5,
    announcement_items_limit: 5,
    weekly_backup_enabled: 0,
    weekly_backup_chat_id: '',
    weekly_backup_weekday: 0,
    weekly_backup_time: '08:00',
    backup_retention_count: 4,
    audit_retention_days: 90,
    notes_retention_days: 365,
    completed_items_retention_days: 0,
    maintenance_pruned_on: '',
    maintenance_vacuumed_month: '',
    last_weekly_backup_on: '',
    photo_derivatives_migrated: 0,
    photo_derivative_migration_on: '',
    librus_sync_timetable: 'manual',
    librus_sync_grades: 'daily',
    librus_sync_notifications: 'daily',
    librus_sync_announcements: 'daily',
    librus_sync_messages: 'daily',
    librus_sync_time: '06:00',
    librus_sync_weekday: 1,
    meal_default_slots: '["Breakfast","Lunch","Dinner","Snack"]',
    kiosk_pin: '',
    gemini_model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    gemini_system_prompt: `You are the smart assistant for a family smart home tablet dashboard. Today is ${new Date().toISOString().slice(0, 10)}.\nAnalyze the user's natural language input and return ONLY raw JSON matching this schema:\n{\n  "notes": ["string of note content"],\n  "tasks": [\n    {\n      "title": "string",\n      "assignee": "string or null",\n      "reward": 0,\n      "due_date": "YYYY-MM-DD or null",\n      "due_time": "HH:MM or null",\n      "recurrence": "none|daily|weekly|weekdays|weekends|interval",\n      "recurrence_interval": 1,\n      "action": "add"\n    }\n  ],\n  "shopping_items": [\n    {\n      "content": "string (e.g. milk, eggs)",\n      "action": "add"\n    }\n  ],\n  "calendar_events": [\n    {\n      "title": "string",\n      "date": "YYYY-MM-DD",\n      "time": "HH:MM or null",\n      "all_day": false\n    }\n  ],\n  "timer": {\n    "action": "start",\n    "minutes": 5\n  },\n  "response_message": "Friendly 1-line confirmation of what was created or done"\n}\n\nRules:\n1. Shopping items: If the user mentions groceries, shopping, buy X, need X, put them in shopping_items.\n2. Calendar events: If user mentions an appointment, meeting, practice, schedule, event with a date or time, put them in calendar_events with accurate ISO date (e.g. tomorrow = calculate relative to today).\n3. Timer: If user says "set timer for 10 minutes", populate timer object (minutes as number).\n4. Tasks: Chores, to-dos, things to do. If reward is mentioned (e.g. "for 15 points"), set reward number. If the user mentions a date or time, fill due_date and due_time. If they say recurring, use recurrence and recurrence_interval.\n5. Notes: Generic info, reminders, thoughts.\n6. Only return non-empty arrays/objects when detected. If a field is not present, use empty array [] or null for timer. If the request is not clearly actionable, return notes with the user text as a reminder.`,
    gemini_text_prompt: 'Extract actionable family dashboard items from the message and return only the structured JSON schema described above.',
    gemini_voice_prompt: 'Please listen carefully to this voice recording, transcribe it, and extract the smart home actions according to the schema.',
    gemini_summary_prompt: 'You are a cheerful school-day helper for a family dashboard. Read the full context and write a short, warm, and relevant summary for the child in the requested language. Include weather, first lesson, required materials, chores/todos, reminders, and school notices only when they are actually present. Do not invent missing facts. Keep it encouraging and human, like a caring parent or teacher. Return plain text only, no JSON, no markdown.'
  };
  const numericKeys = [
    'sleep_timeout',
    'sleep_timeout_day',
    'sleep_timeout_night',
    'photo_interval',
    'photo_interval_day',
    'photo_interval_night',
    'night_mode_enabled',
    'header_clock_enabled',
    'header_weather_enabled',
    'https_enabled',
    'https_port',
    'https_redirect_http',
    'notification_items_limit',
    'announcement_items_limit',
    'weekly_backup_enabled',
    'weekly_backup_weekday',
    'backup_retention_count',
    'audit_retention_days',
    'notes_retention_days',
    'completed_items_retention_days',
    'photo_derivatives_migrated'
  ];
  for (const r of rows) {
    if (numericKeys.includes(r.key)) {
      if (r.value === 'true') settings[r.key] = 1;
      else if (r.value === 'false') settings[r.key] = 0;
      else {
        const num = Number(r.value);
        settings[r.key] = Number.isNaN(num) ? 0 : num;
      }
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
      const normalizedVal = typeof v === 'boolean' ? (v ? '1' : '0') : (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''));
      insertOrReplace.run(k, normalizedVal);
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

function updatePhotoFilename(id, filename) {
  db.prepare('UPDATE photos SET filename = ? WHERE id = ?').run(String(filename), Number(id));
  return getPhotoById(id);
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

function clearCalendarFeedProfileIfMissing(id) {
  return db.prepare(`
    UPDATE calendar_feeds
    SET profile_id = NULL
    WHERE id = ? AND profile_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM profiles WHERE profiles.id = calendar_feeds.profile_id)
  `).run(Number(id));
}

function cleanOrphanedEventProfileIds(feedId) {
  return db.prepare(`
    UPDATE calendar_events
    SET profile_id = NULL
    WHERE feed_id = ? AND profile_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM profiles WHERE profiles.id = calendar_events.profile_id)
  `).run(Number(feedId));
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

function getCalendarEvents({ profileId = null, limit = 100, fromDate = undefined } = {}) {
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 1);
  const effectiveFromDate = fromDate === null ? null : (fromDate || defaultFrom.toISOString().slice(0, 10));

  let query = `
    SELECT e.*, p.name as profile_name, p.color as profile_color 
    FROM calendar_events e 
    LEFT JOIN profiles p ON e.profile_id = p.id
  `;
  const conditions = [];
  const params = [];

  if (effectiveFromDate) {
    conditions.push('e.start_datetime >= ?');
    params.push(effectiveFromDate);
  }
  if (profileId) {
    conditions.push('(e.profile_id IS NULL OR e.profile_id = ?)');
    params.push(profileId);
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY e.start_datetime ASC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

function insertCalendarEvent({ uid = null, feed_id = null, title, description = null, start_datetime, end_datetime = null, all_day = 0, profile_id = null, color = '#38bdf8', source = 'manual' }) {
  const trimmedTitle = title.trim();
  const existing = db.prepare(`
    SELECT * FROM calendar_events 
    WHERE title = ? AND start_datetime = ? AND (profile_id = ? OR (profile_id IS NULL AND ? IS NULL))
  `).get(trimmedTitle, start_datetime, profile_id || null, profile_id || null);
  if (existing) {
    return existing;
  }

  const stmt = db.prepare(`
    INSERT INTO calendar_events (uid, feed_id, title, description, start_datetime, end_datetime, all_day, profile_id, color, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    uid,
    feed_id,
    trimmedTitle,
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

function updateCalendarEvent(id, { title, description, start_datetime, end_datetime, all_day, profile_id, color }) {
  const current = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!current) return null;
  db.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?, all_day = ?, profile_id = ?, color = ?
    WHERE id = ?
  `).run(
    title !== undefined ? String(title).trim() : current.title,
    description !== undefined ? description : current.description,
    start_datetime !== undefined ? start_datetime : current.start_datetime,
    end_datetime !== undefined ? end_datetime : current.end_datetime,
    all_day !== undefined ? (all_day ? 1 : 0) : current.all_day,
    profile_id !== undefined ? (profile_id || null) : current.profile_id,
    color !== undefined ? color : current.color,
    id
  );
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
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

function deleteOldCalendarEventsByFeed(feedId, beforeDateIso) {
  return db.prepare('DELETE FROM calendar_events WHERE feed_id = ? AND start_datetime < ?').run(feedId, beforeDateIso);
}

function deleteOldCalendarEvents(beforeDateIso) {
  return db.prepare("DELETE FROM calendar_events WHERE (feed_id IS NOT NULL OR source != 'manual') AND start_datetime < ?").run(beforeDateIso);
}

/* ==========================================================================
   Dishes & Meal Menus (Menu of the Week) Methods
   ========================================================================== */
function parseJsonArray(val, fallback = []) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return fallback;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      return trimmed.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    }
  }
  return fallback;
}

function normalizeDishRow(row) {
  if (!row) return null;
  return {
    ...row,
    ingredients: parseJsonArray(row.ingredients, []),
    tags: parseJsonArray(row.tags, []).map(t => String(t).trim().toLowerCase()).filter(Boolean)
  };
}

function getDishes({ tag = null, search = null } = {}) {
  const rows = db.prepare('SELECT * FROM dishes ORDER BY name ASC, id DESC').all();
  let list = rows.map(normalizeDishRow);
  if (tag) {
    const cleanTag = String(tag).trim().toLowerCase();
    list = list.filter(d => d.tags.includes(cleanTag));
  }
  if (search) {
    const q = String(search).trim().toLowerCase();
    list = list.filter(d =>
      d.name.toLowerCase().includes(q) ||
      d.tags.some(t => t.includes(q)) ||
      d.ingredients.some(ing => String(ing).toLowerCase().includes(q))
    );
  }
  return list;
}

function getDishById(id) {
  const row = db.prepare('SELECT * FROM dishes WHERE id = ?').get(Number(id));
  return normalizeDishRow(row);
}

function insertDish({ name, photo_filename = null, ingredients = [], recipe = '', tags = [] }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Dish name is required');
  const ingArr = parseJsonArray(ingredients, []);
  const tagArr = parseJsonArray(tags, []).map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const info = db.prepare(`
    INSERT INTO dishes (name, photo_filename, ingredients, recipe, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    cleanName,
    photo_filename || null,
    JSON.stringify(ingArr),
    String(recipe || ''),
    JSON.stringify(tagArr)
  );
  return getDishById(info.lastInsertRowid);
}

function updateDish(id, { name, photo_filename, ingredients, recipe, tags }) {
  const current = getDishById(id);
  if (!current) return null;
  const nextName = name !== undefined ? String(name).trim() : current.name;
  const nextPhoto = photo_filename !== undefined ? (photo_filename || null) : current.photo_filename;
  const nextIng = ingredients !== undefined ? parseJsonArray(ingredients, []) : current.ingredients;
  const nextRecipe = recipe !== undefined ? String(recipe) : current.recipe;
  const nextTags = tags !== undefined
    ? parseJsonArray(tags, []).map(t => String(t).trim().toLowerCase()).filter(Boolean)
    : current.tags;

  db.prepare(`
    UPDATE dishes
    SET name = ?, photo_filename = ?, ingredients = ?, recipe = ?, tags = ?
    WHERE id = ?
  `).run(
    nextName || current.name,
    nextPhoto,
    JSON.stringify(nextIng),
    nextRecipe,
    JSON.stringify(nextTags),
    Number(id)
  );
  return getDishById(id);
}

function deleteDish(id) {
  return db.prepare('DELETE FROM dishes WHERE id = ?').run(Number(id));
}

function getDefaultMealSlots() {
  const settings = getSettings();
  const slots = parseJsonArray(settings.meal_slots || settings.meal_default_slots, ['Breakfast', 'Lunch', 'Dinner', 'Snack']);
  return slots.length > 0 ? slots : ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
}

function normalizeMealMenuRow(row) {
  if (!row) return null;
  const defaultSlots = getDefaultMealSlots();
  const mealSlots = parseJsonArray(row.meal_slots, defaultSlots);
  let schedule = {};
  if (row.schedule && typeof row.schedule === 'object') {
    schedule = row.schedule;
  } else if (typeof row.schedule === 'string') {
    try {
      schedule = JSON.parse(row.schedule || '{}');
    } catch (e) {
      schedule = {};
    }
  }
  const normalizedSchedule = schedule && typeof schedule === 'object' ? schedule : {};
  return {
    ...row,
    is_template: Boolean(row.is_template),
    is_active: Boolean(row.is_active),
    meal_slots: mealSlots.length > 0 ? mealSlots : defaultSlots,
    schedule: normalizedSchedule,
    plan: normalizedSchedule
  };
}

function getMealMenus() {
  const rows = db.prepare('SELECT * FROM meal_menus ORDER BY is_active DESC, is_template ASC, updated_at DESC, id DESC').all();
  return rows.map(normalizeMealMenuRow);
}

function getMealMenuById(id) {
  const row = db.prepare('SELECT * FROM meal_menus WHERE id = ?').get(Number(id));
  return normalizeMealMenuRow(row);
}

function getActiveMealMenu(weekStart = null) {
  if (weekStart) {
    const byWeek = db.prepare('SELECT * FROM meal_menus WHERE week_start = ? AND is_template = 0 ORDER BY is_active DESC, updated_at DESC LIMIT 1').get(String(weekStart));
    if (byWeek) return normalizeMealMenuRow(byWeek);
  }
  const active = db.prepare('SELECT * FROM meal_menus WHERE is_active = 1 AND is_template = 0 ORDER BY updated_at DESC, id DESC LIMIT 1').get();
  if (active) return normalizeMealMenuRow(active);
  const fallback = db.prepare('SELECT * FROM meal_menus WHERE is_template = 0 ORDER BY updated_at DESC, id DESC LIMIT 1').get();
  return normalizeMealMenuRow(fallback);
}

function insertMealMenu({ name, is_template = 0, week_start = null, is_active = 0, meal_slots = null, schedule = undefined, plan = undefined }) {
  const cleanName = String(name || 'Weekly Menu').trim() || 'Weekly Menu';
  const slots = parseJsonArray(meal_slots, getDefaultMealSlots());
  const rawSched = schedule !== undefined ? schedule : (plan !== undefined ? plan : {});
  const schedObj = (typeof rawSched === 'string') ? JSON.parse(rawSched || '{}') : (rawSched || {});

  if (is_active && !is_template) {
    db.prepare('UPDATE meal_menus SET is_active = 0 WHERE is_template = 0').run();
  }

  const info = db.prepare(`
    INSERT INTO meal_menus (name, is_template, week_start, is_active, meal_slots, schedule, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    cleanName,
    is_template ? 1 : 0,
    week_start ? String(week_start) : null,
    is_active ? 1 : 0,
    JSON.stringify(slots),
    JSON.stringify(schedObj)
  );
  return getMealMenuById(info.lastInsertRowid);
}

function updateMealMenu(id, { name, is_template, week_start, is_active, meal_slots, schedule, plan }) {
  const current = getMealMenuById(id);
  if (!current) return null;

  const nextIsTemplate = is_template !== undefined ? (is_template ? 1 : 0) : (current.is_template ? 1 : 0);
  const nextIsActive = is_active !== undefined ? (is_active ? 1 : 0) : (current.is_active ? 1 : 0);

  if (nextIsActive && !nextIsTemplate) {
    db.prepare('UPDATE meal_menus SET is_active = 0 WHERE is_template = 0 AND id != ?').run(Number(id));
  }

  const nextName = name !== undefined ? (String(name).trim() || current.name) : current.name;
  const nextWeekStart = week_start !== undefined ? (week_start ? String(week_start) : null) : current.week_start;
  const nextSlots = meal_slots !== undefined ? parseJsonArray(meal_slots, current.meal_slots) : current.meal_slots;
  const rawNextSched = schedule !== undefined ? schedule : plan;
  const nextSchedule = rawNextSched !== undefined
    ? (typeof rawNextSched === 'string' ? JSON.parse(rawNextSched || '{}') : (rawNextSched || {}))
    : current.schedule;

  db.prepare(`
    UPDATE meal_menus
    SET name = ?, is_template = ?, week_start = ?, is_active = ?, meal_slots = ?, schedule = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    nextName,
    nextIsTemplate,
    nextWeekStart,
    nextIsActive,
    JSON.stringify(nextSlots),
    JSON.stringify(nextSchedule),
    Number(id)
  );
  return getMealMenuById(id);
}

function deleteMealMenu(id) {
  return db.prepare('DELETE FROM meal_menus WHERE id = ?').run(Number(id));
}

function applyMealMenuTemplate(templateId, { week_start = null, name = null, set_active = true } = {}) {
  const tpl = getMealMenuById(templateId);
  if (!tpl) return null;
  const existingForWeek = week_start
    ? db.prepare('SELECT * FROM meal_menus WHERE week_start = ? AND is_template = 0 LIMIT 1').get(String(week_start))
    : null;
  if (existingForWeek) {
    return updateMealMenu(existingForWeek.id, {
      name: name || existingForWeek.name,
      is_active: set_active ? 1 : existingForWeek.is_active,
      meal_slots: tpl.meal_slots,
      schedule: tpl.schedule
    });
  }
  return insertMealMenu({
    name: name || (week_start ? `Menu for ${week_start}` : `${tpl.name} (Active)`),
    is_template: 0,
    week_start: week_start || null,
    is_active: set_active ? 1 : 0,
    meal_slots: tpl.meal_slots,
    schedule: tpl.schedule
  });
}

function setMealSlotEntry(arg1, dayArg, slotArg, entriesArg) {
  let menu_id = null;
  let week_start = null;
  let day;
  let slot;
  let entries;

  if (arg1 && typeof arg1 === 'object' && ('day' in arg1 || 'slot' in arg1 || 'entries' in arg1)) {
    menu_id = arg1.menu_id ?? null;
    week_start = arg1.week_start ?? null;
    day = arg1.day;
    slot = arg1.slot;
    entries = arg1.entries;
  } else {
    menu_id = arg1 ?? null;
    day = dayArg;
    slot = slotArg;
    entries = entriesArg;
  }

  let menu = menu_id ? getMealMenuById(menu_id) : getActiveMealMenu(week_start);
  if (!menu) {
    menu = insertMealMenu({
      name: week_start ? `Menu for ${week_start}` : 'Family Weekly Menu',
      is_template: 0,
      week_start: week_start || null,
      is_active: 1,
      meal_slots: getDefaultMealSlots(),
      schedule: {}
    });
  }
  const schedule = { ...(menu.schedule || {}) };
  if (!schedule[day] || typeof schedule[day] !== 'object') {
    schedule[day] = {};
  }
  schedule[day][slot] = Array.isArray(entries) ? entries : (entries ? [entries] : []);
  const slots = Array.isArray(menu.meal_slots) ? [...menu.meal_slots] : getDefaultMealSlots();
  if (slot && !slots.includes(slot)) {
    slots.push(slot);
  }
  return updateMealMenu(menu.id, { meal_slots: slots, schedule });
}

function getLibrusData(profileId = null) {
  const rows = profileId
    ? db.prepare('SELECT key, value, updated_at FROM librus_profile_data WHERE profile_id = ?').all(Number(profileId))
    : db.prepare('SELECT key, value, updated_at FROM librus_data').all();
  const payload = {};
  for (const row of rows) {
    try {
      payload[row.key] = JSON.parse(row.value);
    } catch (e) {
      payload[row.key] = row.value;
    }
  }
  return {
    grades: Array.isArray(payload.grades) ? payload.grades : [],
    notifications: Array.isArray(payload.notifications) ? payload.notifications : [],
    notification_counts: payload.notification_counts && typeof payload.notification_counts === 'object' ? payload.notification_counts : {},
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    announcements: Array.isArray(payload.announcements) ? payload.announcements : [],
    sync_errors: Array.isArray(payload.sync_errors) ? payload.sync_errors : [],
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    timetable: Array.isArray(payload.timetable) ? payload.timetable : [],
    account: payload.account || null,
    updated_at: payload.updated_at || null
  };
}

function saveLibrusData(payload = {}, profileId = null) {
  const clean = {
    grades: Array.isArray(payload.grades) ? payload.grades : [],
    notifications: Array.isArray(payload.notifications) ? payload.notifications : [],
    notification_counts: payload.notification_counts && typeof payload.notification_counts === 'object' ? payload.notification_counts : {},
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    announcements: Array.isArray(payload.announcements) ? payload.announcements : [],
    sync_errors: Array.isArray(payload.sync_errors) ? payload.sync_errors : [],
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    timetable: Array.isArray(payload.timetable) ? payload.timetable : [],
    account: payload.account || null,
    updated_at: new Date().toISOString()
  };

  for (const [key, value] of Object.entries(clean)) {
    if (profileId) {
      db.prepare(`
        INSERT INTO librus_profile_data (profile_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(Number(profileId), key, JSON.stringify(value), clean.updated_at);
    } else {
      db.prepare(`
        INSERT INTO librus_data (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), clean.updated_at);
    }
  }

  return getLibrusData(profileId);
}

function getAllLibrusProfileData() {
  const ids = db.prepare('SELECT DISTINCT profile_id FROM librus_profile_data ORDER BY profile_id').all();
  return Object.fromEntries(ids.map(({ profile_id }) => [String(profile_id), getLibrusData(profile_id)]));
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
  const pKey = String(profile_key);
  const pNum = Number(page) || 0;
  const tVal = theme || 'inherit';
  const fVal = font_size || 'inherit';

  const existing = db.prepare('SELECT id FROM page_configs WHERE profile_key = ? AND page = ?').get(pKey, pNum);
  if (existing) {
    db.prepare('UPDATE page_configs SET theme = ?, font_size = ? WHERE id = ?').run(tVal, fVal, existing.id);
  } else {
    db.prepare('INSERT INTO page_configs (profile_key, page, theme, font_size) VALUES (?, ?, ?, ?)').run(pKey, pNum, tVal, fVal);
  }
  return getPageConfigs();
}

/* ==========================================================================
   Rewards & Redemptions (Kids Chore Reward Store) Methods
   ========================================================================== */
function getRewards() {
  return db.prepare('SELECT * FROM rewards ORDER BY cost ASC, id ASC').all();
}

function getRewardById(id) {
  return db.prepare('SELECT * FROM rewards WHERE id = ?').get(Number(id));
}

function insertReward({ title, cost = 10, icon = '🎁', profile_id = null }) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('Reward title is required');
  const numCost = Math.max(1, Math.round(Number(cost) || 10));
  const info = db.prepare(`
    INSERT INTO rewards (title, cost, icon, profile_id)
    VALUES (?, ?, ?, ?)
  `).run(cleanTitle, numCost, String(icon || '🎁').trim() || '🎁', profile_id ? Number(profile_id) : null);
  return getRewardById(info.lastInsertRowid);
}

function updateReward(id, { title, cost, icon, profile_id }) {
  const current = getRewardById(id);
  if (!current) return null;
  db.prepare(`
    UPDATE rewards
    SET title = ?, cost = ?, icon = ?, profile_id = ?
    WHERE id = ?
  `).run(
    title !== undefined ? (String(title).trim() || current.title) : current.title,
    cost !== undefined ? Math.max(1, Math.round(Number(cost) || current.cost)) : current.cost,
    icon !== undefined ? (String(icon).trim() || current.icon) : current.icon,
    profile_id !== undefined ? (profile_id ? Number(profile_id) : null) : current.profile_id,
    Number(id)
  );
  return getRewardById(id);
}

function deleteReward(id) {
  return db.prepare('DELETE FROM rewards WHERE id = ?').run(Number(id));
}

function getRewardRedemptions(limit = 30) {
  return db.prepare(`
    SELECT r.*, COALESCE(r.points_spent, r.cost) AS points_spent, p.name AS profile_name, p.color AS profile_color, p.avatar_value AS profile_avatar
    FROM reward_redemptions r
    LEFT JOIN profiles p ON r.profile_id = p.id
    ORDER BY r.redeemed_at DESC, r.id DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 30));
}

function redeemReward(profileId, rewardId) {
  const profile = getProfileById(profileId);
  if (!profile) {
    return { ok: false, error: 'Profile not found' };
  }
  const reward = getRewardById(rewardId);
  if (!reward) {
    return { ok: false, error: 'Reward not found' };
  }
  const cost = Math.max(1, Number(reward.cost) || 1);
  const currentPoints = Number(profile.points_balance) || 0;
  if (currentPoints < cost) {
    return {
      ok: false,
      error: `Not enough points (${currentPoints}/${cost} ⭐)`
    };
  }

  const nextPoints = currentPoints - cost;
  const tx = db.transaction(() => {
    db.prepare('UPDATE profiles SET points_balance = ? WHERE id = ?').run(nextPoints, Number(profile.id));
    const info = db.prepare(`
      INSERT INTO reward_redemptions (profile_id, reward_id, reward_title, reward_icon, cost, points_spent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Number(profile.id), Number(reward.id), reward.title, reward.icon || '🎁', cost, cost);
    return info.lastInsertRowid;
  });

  const redemptionId = tx();
  const redemption = db.prepare(`
    SELECT r.*, COALESCE(r.points_spent, r.cost) AS points_spent, p.name AS profile_name, p.color AS profile_color
    FROM reward_redemptions r
    LEFT JOIN profiles p ON r.profile_id = p.id
    WHERE r.id = ?
  `).get(redemptionId);
  if (redemption) {
    redemption.remaining_points = nextPoints;
  }

  return {
    ok: true,
    profile: getProfileById(profile.id),
    reward,
    redemption
  };
}

/* ==========================================================================
   Unified Dashboard State
   ========================================================================== */
function getDashboardData({ includePrivateSettings = false } = {}) {
  const settings = getSettings();
  settings.has_kiosk_pin = Boolean(settings.kiosk_pin && String(settings.kiosk_pin).trim());
  if (!includePrivateSettings) {
    delete settings.weekly_backup_chat_id;
    delete settings.kiosk_pin;
  }
  const profiles = getProfiles();
  if (!includePrivateSettings) {
    profiles.forEach(profile => {
      delete profile.telegram_id;
      delete profile.librus_login;
      delete profile.librus_password;
    });
  }
  return {
    notes: getNotes(),
    tasks: getTasks(),
    profiles,
    schedules: getSchedules(),
    lists: getLists(),
    layouts: getWidgetLayouts(null),
    profile_layouts: getAllProfileLayouts(),
    page_configs: getPageConfigs(),
    photos: getPhotos({ screensaverOnly: true }),
    events: getCalendarEvents({ limit: 250 }),
    feeds: getCalendarFeeds(),
    dishes: getDishes(),
    meal_menus: getMealMenus(),
    rewards: getRewards(),
    reward_redemptions: getRewardRedemptions(30),
    settings,
    librus: getLibrusData(),
    librus_by_profile: getAllLibrusProfileData()
  };
}

/* ==========================================================================
   Audit Log Methods
   ========================================================================== */
function insertAuditLog({
  source,
  sender_id = null,
  sender_name = null,
  message_type = 'text',
  raw_input = null,
  parsed_payload = null,
  action_taken = null,
  status = 'success',
  error_message = null
}) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (source, sender_id, sender_name, message_type, raw_input, parsed_payload, action_taken, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const payloadStr = parsed_payload
    ? (typeof parsed_payload === 'string' ? parsed_payload : JSON.stringify(parsed_payload))
    : null;
  const info = stmt.run(
    source || 'system',
    sender_id ? String(sender_id) : null,
    sender_name ? String(sender_name) : null,
    message_type || 'text',
    raw_input ? String(raw_input) : null,
    payloadStr,
    action_taken ? String(action_taken) : null,
    status || 'success',
    error_message ? String(error_message) : null
  );
  return db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(info.lastInsertRowid);
}

function getAuditLogs({ limit = 100, offset = 0, source = null, status = null } = {}) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit) || 100, Number(offset) || 0);
  return db.prepare(sql).all(...params);
}

function clearAuditLogs() {
  return db.prepare('DELETE FROM audit_logs').run();
}

function getScheduledSubscriptions() {
  return db.prepare(`
    SELECT s.*, p.name AS profile_name, p.telegram_id, p.language
    FROM scheduled_subscriptions s
    JOIN profiles p ON p.id = s.profile_id
    ORDER BY p.name, s.type
  `).all();
}

function upsertScheduledSubscription({ profile_id, type, send_time = '07:00', enabled = true, initial_cursor = null }) {
  db.prepare(`
    INSERT INTO scheduled_subscriptions (profile_id, type, send_time, enabled, last_cursor)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type) DO UPDATE SET
      send_time = excluded.send_time,
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(Number(profile_id), String(type), /^\d{2}:\d{2}$/.test(send_time) ? send_time : '07:00', enabled ? 1 : 0, initial_cursor === null ? null : String(initial_cursor));
  return getScheduledSubscriptions().find(item => item.profile_id === Number(profile_id) && item.type === type);
}

function markScheduledSubscriptionSent(id, date, cursor = null) {
  return db.prepare('UPDATE scheduled_subscriptions SET last_sent_on = ?, last_cursor = COALESCE(?, last_cursor), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(date, cursor, id);
}

function pruneData({ auditDays = 90, notesDays = 365, completedTaskDays = 180 } = {}) {
  const audit = db.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now', ?)").run(`-${Math.max(1, Number(auditDays) || 90)} days`);
  const notes = db.prepare("DELETE FROM notes WHERE timestamp < datetime('now', ?)").run(`-${Math.max(1, Number(notesDays) || 365)} days`);
  const keepCompletedHistory = Number(completedTaskDays) > 0;
  const items = keepCompletedHistory ? db.prepare(`
    DELETE FROM list_items
    WHERE checked = 1 AND COALESCE(recurrence, 'none') = 'none'
      AND COALESCE(last_completed_at, created_at) < datetime('now', ?)
  `).run(`-${Number(completedTaskDays)} days`) : { changes: 0 };
  return { auditLogs: audit.changes, notes: notes.changes, completedListItems: items.changes };
}

module.exports = {
  db,
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
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
  getProfiles,
  getProfileById,
  getRawProfileById,
  getProfileByTelegramId,
  insertProfile,
  updateProfile,
  addProfilePoints,
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
  inferShoppingCategory,
  parseIngredientQuantity,
  formatIngredientWithQuantity,
  insertListItem,
  addIngredientsToShoppingList,
  toggleListItemChecked,
  updateListItem,
  deleteListItem,
  clearCompletedListItems,
  calculateNextDueDate,
  getWidgetLayouts,
  getAllProfileLayouts,
  saveWidgetLayouts,
  getPageConfigs,
  savePageConfig,
  getSettings,
  updateSettings,
  getPhotos,
  getPhotoById,
  updatePhotoFilename,
  insertPhoto,
  updatePhoto,
  deletePhoto,
  getCalendarFeeds,
  getCalendarFeedById,
  clearCalendarFeedProfileIfMissing,
  cleanOrphanedEventProfileIds,
  insertCalendarFeed,
  updateCalendarFeedSyncTime,
  deleteCalendarFeed,
  getCalendarEvents,
  insertCalendarEvent,
  updateCalendarEvent,
  upsertCalendarEventByUid,
  deleteCalendarEvent,
  deleteOldCalendarEventsByFeed,
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
  getRewards,
  getRewardById,
  insertReward,
  updateReward,
  deleteReward,
  getRewardRedemptions,
  redeemReward,
  saveLibrusData,
  getLibrusData,
  getAllLibrusProfileData,
  getDashboardData,
  insertAuditLog,
  getAuditLogs,
  clearAuditLogs,
  getScheduledSubscriptions,
  upsertScheduledSubscription,
  markScheduledSubscriptionSent,
  pruneData
};

