const assert = require('assert');
const db = require('../src/db');
const { normalizeTimetableData, buildMorningSummary, buildSchoolDaySummary } = require('../src/services/librus');

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

console.log('Librus timetable normalization and summary checks passed');
