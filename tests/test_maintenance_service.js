const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMaintenanceService, getDueLibrusSyncs } = require('../src/services/maintenance');

async function run() {
  const sunday = new Date(2026, 9, 11, 8, 0, 0);
  assert.strictEqual(getDueLibrusSyncs({ librus_sync_timetable: 'manual' }, sunday).length, 0);
  assert.strictEqual(getDueLibrusSyncs({ librus_sync_timetable: 'daily', librus_sync_time: '08:00' }, sunday).length, 1);
  assert.strictEqual(getDueLibrusSyncs({ librus_sync_timetable: 'weekly', librus_sync_weekday: 0, librus_sync_time: '08:00' }, sunday).length, 1);
  assert.strictEqual(getDueLibrusSyncs({ librus_sync_timetable: 'hourly' }, new Date(2026, 9, 11, 8, 0)).length, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-maintenance-'));
  const sent = [];
  const audited = [];
  const settings = {
    weekly_backup_enabled: 1,
    weekly_backup_chat_id: '1234',
    weekly_backup_weekday: 0,
    weekly_backup_time: '08:00',
    backup_retention_count: 2,
    audit_retention_days: 90,
    notes_retention_days: 365,
    completed_items_retention_days: 180,
    last_weekly_backup_on: '',
    maintenance_pruned_on: ''
  };
  const subscription = { id: 1, profile_id: 2, profile_name: 'Mia', telegram_id: '777', type: 'morning_summary', send_time: '08:00', enabled: 1, last_sent_on: null };
  let retentionRuns = 0;
  let backupCalls = 0;
  const service = createMaintenanceService({
    db: { backup: async destination => { backupCalls++; await fs.promises.writeFile(destination, 'sqlite backup'); }, pragma: () => {} },
    bot: { telegram: { sendDocument: async (chatId, file) => sent.push({ chatId, file: file.source }), sendMessage: async (chatId, text) => sent.push({ chatId, text }) } },
    getSettings: () => ({ ...settings }),
    updateSettings: changes => Object.assign(settings, changes),
    pruneData: () => { retentionRuns++; return { auditLogs: 0, notes: 0, completedListItems: 0 }; },
    getSubscriptions: () => [subscription],
    markSubscriptionSent: (id, date) => { subscription.last_sent_on = date; },
    getLists: () => [{ type: 'tasks', items: [{ content: 'Pack school bag', checked: 0, assignee_profile_id: 2, due_date: '2026-10-11' }] }],
    getSchedules: () => [{ profile_id: 2, schedule: [{ day: 'Monday', lessons: [{ name: 'Math' }] }] }],
    getLibrusData: () => ({ grades: [], notifications: [], announcements: [], messages: [] }),
    getWeather: async () => null,
    buildSummary: ({ tasks }) => `Morning tasks: ${tasks.map(task => task.content).join(', ')}`,
    syncLibrus: async () => {},
    audit: record => audited.push(record),
    backupDirectory: dir,
    clock: () => sunday,
    logger: { error: () => {} }
  });

  await service.runOnce(sunday);
  assert.strictEqual(backupCalls, 1, 'scheduled backup should create a DB snapshot');
  assert(sent.some(item => item.chatId === '1234' && item.file), 'weekly DB snapshot should be delivered to configured chat');
  assert(sent.some(item => item.chatId === '777' && item.text.includes('Pack school bag')), 'morning summary should be sent to the subscribed profile');
  assert.strictEqual(retentionRuns, 1, 'retention cleanup should run once per local day');
  assert(audited.some(entry => entry.source === 'scheduled_job' && entry.action_taken.includes('backup')), 'backup operation should be audited');
  assert(audited.some(entry => entry.action_taken.includes('morning_summary')), 'subscription delivery should be audited');

  fs.writeFileSync(path.join(dir, 'dashboard-2026-10-04.db'), 'old');
  fs.writeFileSync(path.join(dir, 'dashboard-2026-10-05.db'), 'old');
  fs.writeFileSync(path.join(dir, 'dashboard-2026-10-06.db'), 'old');
  assert.strictEqual(await service.pruneBackups(2), 2, 'backup retention should trim files beyond configured count');
  assert.strictEqual((await fs.promises.readdir(dir)).filter(name => name.endsWith('.db')).length, 2);
  await fs.promises.rm(dir, { recursive: true, force: true });
  console.log('Maintenance scheduler backup, retention, subscription, and cadence checks passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
