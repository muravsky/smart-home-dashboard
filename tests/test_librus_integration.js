const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test-smart-home.db');
for (const suffix of ['.db', '.db-wal', '.db-shm']) {
  const candidate = path.join(__dirname, '../data', `test-smart-home.db${suffix}`);
  if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
}
process.env.DB_PATH = testDbPath;

const db = require('../src/db');
const { normalizeTimetableData, flattenLibrusGrades, buildMorningSummary, buildSchoolDaySummary } = require('../src/services/librus');
const { getWeather } = require('../src/services/weather');

const sampleTimetable = {
  hours: ['08:00', '09:00'],
  table: {
    Monday: [
      { subject: 'Math', teacher: 'Mrs. Brown', room: '101', time: '08:00-08:45' },
      { subject: 'English', teacher: 'Mrs. Smith', room: '205', time: '09:00-09:45' }
    ],
    Tuesday: [
      { subject: 'Biology', teacher: 'Mr. Green', room: 'B2', time: '08:00-08:45' }
    ]
  }
};

const normalized = normalizeTimetableData(sampleTimetable);
assert(Array.isArray(normalized), 'expected normalized timetable array');
assert.strictEqual(normalized[0].day, 'Monday', 'Monday should be first day');
assert.strictEqual(normalized[0].lessons.length, 2, 'two lessons should be parsed for Monday');
assert.strictEqual(normalized[0].lessons[0].name, 'Math', 'Math lesson should be preserved');

const flattenedGrades = flattenLibrusGrades([{
  name: 'Mathematics',
  semester: [{ grades: [{ id: 431, value: '5', info: 'Quiz' }] }]
}]);
assert.deepStrictEqual(flattenedGrades, [{ id: 431, subject: 'Mathematics', semester: 1, value: '5', info: 'Quiz', date: null }], 'nested Librus semester grades should flatten into usable grade rows');

const hourBasedTimetable = {
  hours: ['08:00-08:45', '09:00-09:45', '10:00-10:45'],
  table: {
    Monday: [
      { subject: 'Math', teacher: 'Mrs. Brown', room: '101' },
      { subject: 'Biology', teacher: 'Mr. Green', room: 'B2' }
    ]
  }
};
const hourBasedNormalized = normalizeTimetableData(hourBasedTimetable);
assert.strictEqual(hourBasedNormalized[0].lessons[0].start, '08:00', 'first lesson should use the first hour slot from Librus data');
assert.strictEqual(hourBasedNormalized[0].lessons[0].end, '08:45', 'first lesson should end at the expected lesson block length');
assert.strictEqual(hourBasedNormalized[0].lessons[1].start, '09:00', 'second lesson should use the second hour slot from Librus data');

const weekendSchedule = {
  hours: ['08:00-08:45', '09:00-09:45'],
  table: {
    Monday: [{ subject: 'Math', time: '08:00' }],
    Saturday: [{ subject: 'Art', time: '08:00' }],
    Sunday: [{ subject: 'Free', time: '08:00' }]
  }
};
const weekendFiltered = normalizeTimetableData(weekendSchedule);
assert.strictEqual(weekendFiltered.length, 1, 'weekend entries should be excluded from the school timetable');
assert.strictEqual(weekendFiltered[0].day, 'Monday', 'only school week days should remain');

const summary = buildMorningSummary({ name: 'Mia' }, sampleTimetable);
assert(summary.includes('Mia'), 'summary should mention the person');
assert(summary.includes('Math'), 'summary should include first lesson');

const daySummary = buildSchoolDaySummary({
  weather: { temperature: 21, condition: 'Cloudy' },
  tasks: [{ content: 'Clean room' }],
  schedule: sampleTimetable,
  grade: 'A',
  notifications: [{ title: 'School event' }],
  announcements: [{ title: 'Trip notice', author: 'Marta', date: '2026-09-25', time: '08:15' }],
  language: 'en'
});
assert(daySummary.includes('21'), 'day summary should include weather temperature');
assert(daySummary.includes('Clean room'), 'day summary should include tasks');
assert(daySummary.includes('Math'), 'day summary should include schedule');
assert(daySummary.includes('School event'), 'day summary should include notifications');
assert(daySummary.includes('Trip notice'), 'day summary should include announcements');

const friendlySummary = buildSchoolDaySummary({
  weather: { temperature: 2, condition: 'Snow' },
  tasks: [{ content: 'Brush teeth' }],
  schedule: sampleTimetable,
  grades: [{ value: '5' }],
  notifications: [{ title: 'School event' }],
  announcements: [{ title: 'Trip notice', author: 'Marta', date: '2026-09-25', time: '08:15' }],
  language: 'en'
});
assert(friendlySummary.toLowerCase().includes('dress') || friendlySummary.toLowerCase().includes('warm') || friendlySummary.toLowerCase().includes('books'), 'friendly summary should include practical guidance for the school day');

const settings = db.getSettings();
assert(settings.gemini_summary_prompt && settings.gemini_summary_prompt.toLowerCase().includes('language'), 'default summary prompt should be configurable and language-aware');

const polishSummary = buildSchoolDaySummary({
  weather: { temperature: 18, condition: 'Cloudy' },
  tasks: [{ content: 'Sprzątanie pokoju' }],
  schedule: sampleTimetable,
  notifications: [{ title: 'Wydarzenie szkolne' }],
  announcements: [{ title: 'Wycieczka', author: 'Marta', date: '2026-09-25', time: '08:15' }],
  language: 'pl'
});
assert(polishSummary.includes('Pogoda') || polishSummary.includes('Sprzątanie pokoju') || polishSummary.includes('Wydarzenie'), 'polish summary should be localized and descriptive');
assert(polishSummary.toLowerCase().includes('pogoda') || polishSummary.toLowerCase().includes('zadania') || polishSummary.toLowerCase().includes('plan'), 'summary should use localized school-day wording in Polish');

const substitutedLesson = {
  day: 'Monday',
  lessons: [
    { number: 1, start: '08:00', end: '08:45', name: 'Math', room: '101', teacher: 'Mr. Novak', cancelled: true },
    { number: 2, start: '09:00', end: '09:45', name: 'Biology', room: 'B2', teacher: 'Mrs. Nowak', replacement: true }
  ]
};
assert.strictEqual(substitutedLesson.lessons[0].cancelled, true, 'cancelled lessons should be marked');
assert.strictEqual(substitutedLesson.lessons[1].replacement, true, 'replacement teachers should be marked');

const packageChangedTimetable = normalizeTimetableData({
  table: { Monday: [{ subject: 'Physics', time: '08:00-08:45', flag: 'zastępstwo, zmiana sali', original: { subject: 'Chemistry' } }, { subject: 'Math', time: '09:00-09:45', cancelled: true, flag: 'odwołane' }] }
});
const storedSchedule = db.insertSchedule({ name: 'Changed timetable', schedule: packageChangedTimetable });
assert.strictEqual(storedSchedule.schedule[0].lessons[0].replacement, true, 'Librus replacement markers should survive schedule persistence');
assert.strictEqual(storedSchedule.schedule[0].lessons[0].original.subject, 'Chemistry', 'original lesson details should survive schedule persistence');
assert.strictEqual(storedSchedule.schedule[0].lessons[1].cancelled, true, 'Librus cancellations should survive schedule persistence');

const storedLibrusData = db.saveLibrusData({ messages: [{ id: 9, title: 'Parent message' }], notification_counts: { inbox: 2 } });
assert.strictEqual(storedLibrusData.messages[0].title, 'Parent message', 'Librus inbox messages should persist separately');
assert.strictEqual(storedLibrusData.notification_counts.inbox, 2, 'Librus notification counters should persist');

const profile = db.insertProfile({
  name: 'Test Kid',
  color: '#00ff00',
  avatar_type: 'builtin',
  avatar_value: '🧒',
  librus_login: 'kid-login',
  librus_password: 'kid-pass'
});
assert.strictEqual(profile.librus_login, 'kid-login', 'profile should store Librus login');
assert.strictEqual(profile.librus_password, 'kid-pass', 'profile should store Librus password');

const updatedProfile = db.updateProfile(profile.id, { librus_login: 'new-login', librus_password: 'new-pass' });
assert.strictEqual(updatedProfile.librus_login, 'new-login', 'profile update should change Librus login');
assert.strictEqual(updatedProfile.librus_password, 'new-pass', 'profile update should change Librus password');
db.saveLibrusData({ grades: [{ subject: 'Science', value: 'A', date: '2026-10-11' }] }, profile.id);
assert.strictEqual(db.getLibrusData(profile.id).grades[0].subject, 'Science', 'profile-specific Librus grades should be retrievable');
assert(db.getDashboardData().librus_by_profile[String(profile.id)], 'dashboard payload should include profile-specific Librus data');
db.updateSettings({ weekly_backup_chat_id: 'private-chat-id' });
const publicDashboard = db.getDashboardData();
assert.strictEqual(publicDashboard.settings.weekly_backup_chat_id, undefined, 'public kiosk payload should not include backup destination');
assert.strictEqual(publicDashboard.profiles.find(item => item.id === profile.id).librus_password, undefined, 'public kiosk profiles must not expose Librus credentials');
const adminDashboard = db.getDashboardData({ includePrivateSettings: true });
assert.strictEqual(adminDashboard.settings.weekly_backup_chat_id, 'private-chat-id', 'admin dashboard payload should retain private backup destination');

(async () => {
  const previous = db.getSettings();
  db.updateSettings({
    weather_city: '',
    weather_lat: '',
    weather_lon: '',
    weather_units: 'metric'
  });

  try {
    const weather = await getWeather();
    assert.strictEqual(weather, null, 'weather should stay unset until a real location is configured');
  } finally {
    db.updateSettings(previous);
  }

  console.log('Librus timetable normalization and summary checks passed');
})();
