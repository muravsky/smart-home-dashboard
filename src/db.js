const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/smart_home.db');

// Ensure parent directory exists
const fs = require('fs');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
`);

/**
 * Insert a note into SQLite
 */
function insertNote(content) {
  const stmt = db.prepare('INSERT INTO notes (content, timestamp) VALUES (?, ?)');
  const info = stmt.run(content, new Date().toISOString());
  return {
    id: info.lastInsertRowid,
    content,
    timestamp: new Date().toISOString()
  };
}

/**
 * Insert a task into SQLite
 */
function insertTask({ assignee = null, title, reward = 0, status = 'pending' }) {
  const stmt = db.prepare('INSERT INTO tasks (assignee, title, reward, status) VALUES (?, ?, ?, ?)');
  const info = stmt.run(assignee, title, Number(reward) || 0, status);
  return {
    id: info.lastInsertRowid,
    assignee,
    title,
    reward: Number(reward) || 0,
    status
  };
}

/**
 * Retrieve notes ordered by latest first
 */
function getNotes(limit = 50) {
  const stmt = db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT ?');
  return stmt.all(limit);
}

/**
 * Retrieve tasks
 */
function getTasks() {
  const stmt = db.prepare('SELECT * FROM tasks ORDER BY id DESC');
  return stmt.all();
}

/**
 * Get unified dashboard data
 */
function getDashboardData() {
  return {
    notes: getNotes(),
    tasks: getTasks()
  };
}

/**
 * Delete a note by ID
 */
function deleteNote(id) {
  const stmt = db.prepare('DELETE FROM notes WHERE id = ?');
  return stmt.run(id);
}

/**
 * Update a task's status (e.g. 'pending', 'completed')
 */
function updateTaskStatus(id, status) {
  const stmt = db.prepare('UPDATE tasks SET status = ? WHERE id = ?');
  return stmt.run(status, id);
}

/**
 * Delete a task by ID
 */
function deleteTask(id) {
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  return stmt.run(id);
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
  getDashboardData
};
