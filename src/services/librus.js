let LibrusApi = null;
try {
  LibrusApi = require('librus-api');
} catch (err) {
  LibrusApi = null;
}

function toDisplayDayName(value) {
  if (!value) return 'Day';
  const cleaned = String(value).trim();
  if (!cleaned) return 'Day';

  const map = {
    mon: 'Monday',
    monday: 'Monday',
    tue: 'Tuesday',
    tuesday: 'Tuesday',
    wed: 'Wednesday',
    wednesday: 'Wednesday',
    thu: 'Thursday',
    thursday: 'Thursday',
    fri: 'Friday',
    friday: 'Friday',
    sat: 'Saturday',
    saturday: 'Saturday',
    sun: 'Sunday',
    sunday: 'Sunday'
  };

  return map[cleaned.toLowerCase()] || cleaned;
}

function parseLessonTime(rawLesson) {
  const fallback = { start: '08:00', end: '08:45', time: null };
  if (!rawLesson || typeof rawLesson !== 'object') return fallback;

  const rawTime = rawLesson.time || rawLesson.start || rawLesson.period || rawLesson.lesson_time || null;
  if (typeof rawTime === 'string' && rawTime.includes('-')) {
    const [start, end] = rawTime.split('-').map((p) => p.trim()).filter(Boolean);
    if (start && end) {
      return { start, end, time: rawTime };
    }
  }

  if (typeof rawTime === 'string' && rawTime.includes(' ')) {
    const [start, end] = rawTime.split(' ').map((p) => p.trim()).filter(Boolean);
    if (start && end) {
      return { start, end, time: rawTime };
    }
  }

  if (typeof rawTime === 'string' && rawTime.length >= 5) {
    return { start: rawTime.slice(0, 5), end: rawTime.slice(0, 5), time: rawTime };
  }

  return fallback;
}

function normalizeSingleLesson(lesson, idx = 0) {
  const source = lesson || {};
  const { start, end, time } = parseLessonTime(source);
  const name = source.subject || source.name || source.title || `Lesson ${idx + 1}`;
  const room = source.room || source.classroom || source.className || source.clazz || '—';
  const teacher = source.teacher || source.teacherName || source.instructor || null;

  return {
    number: Number(source.number || source.no || idx + 1) || idx + 1,
    start,
    end,
    time,
    name: String(name).trim() || `Lesson ${idx + 1}`,
    room: String(room).trim() || '—',
    teacher: teacher ? String(teacher).trim() : null,
    cancelled: Boolean(source.cancelled || source.flag === 'odwołane' || source.flag === 'cancelled'),
    flag: source.flag || null,
    original: source.original || null
  };
}

function normalizeTimetableData(rawTimetable) {
  if (!rawTimetable) return [];

  const sourceTable = rawTimetable.table || rawTimetable.days || rawTimetable;
  if (Array.isArray(sourceTable)) {
    return sourceTable.map((dayEntry, index) => {
      const dayName = dayEntry && (dayEntry.day || dayEntry.name || dayEntry.label) ? String(dayEntry.day || dayEntry.name || dayEntry.label) : `Day ${index + 1}`;
      const lessons = Array.isArray(dayEntry && dayEntry.lessons) ? dayEntry.lessons : Array.isArray(dayEntry) ? dayEntry : [];
      return {
        day: toDisplayDayName(dayName),
        lessons: lessons.map((lesson, lessonIndex) => normalizeSingleLesson(lesson, lessonIndex))
      };
    });
  }

  if (sourceTable && typeof sourceTable === 'object') {
    return Object.entries(sourceTable).map(([dayName, lessons]) => ({
      day: toDisplayDayName(dayName),
      lessons: Array.isArray(lessons) ? lessons.map((lesson, lessonIndex) => normalizeSingleLesson(lesson, lessonIndex)) : []
    }));
  }

  return [];
}

function buildMorningSummary(person, timetableData) {
  const name = (() => {
    if (!person) return 'Student';
    if (typeof person === 'string') return person.trim() || 'Student';
    return person.name || person.first_name || person.label || 'Student';
  })();

  const normalized = normalizeTimetableData(timetableData);
  if (!normalized.length) {
    return `${name}'s school day: no lessons scheduled yet.`;
  }

  const today = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayLabel = dayNames[today.getDay()];
  const todayEntry = normalized.find((entry) => String(entry.day).toLowerCase() === todayLabel.toLowerCase()) || normalized[0];
  const lessons = Array.isArray(todayEntry && todayEntry.lessons) ? todayEntry.lessons : [];

  if (!lessons.length) {
    return `${name}'s school day: no lessons scheduled for ${todayEntry ? todayEntry.day : 'today'}.`;
  }

  const preview = lessons.slice(0, 3).map((lesson) => `${lesson.start || '08:00'} ${lesson.name}`).join(' • ');
  return `${name}'s school day: ${todayEntry.day || 'Today'} — ${preview}.`;
}

function buildSchoolDaySummary({ weather = null, tasks = [], schedule = [], grades = [], notifications = [], announcements = [] } = {}) {
  const parts = [];

  if (weather) {
    const temp = Number(weather.temperature ?? weather.temp ?? weather.current ?? 0);
    const condition = weather.condition || weather.summary || 'Weather';
    const safeTemp = Number.isFinite(temp) ? `${Math.round(temp)}°` : '—';
    parts.push(`Weather: ${safeTemp} ${condition}`);
  }

  const taskList = Array.isArray(tasks) ? tasks.map((task) => task.content || task.title || task.name || 'Task') : [];
  if (taskList.length) {
    parts.push(`Tasks: ${taskList.slice(0, 3).join(', ')}`);
  }

  const normalizedSchedule = normalizeTimetableData(schedule);
  if (normalizedSchedule.length) {
    const today = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayLabel = dayNames[today.getDay()];
    const todayEntry = normalizedSchedule.find((entry) => String(entry.day).toLowerCase() === todayLabel.toLowerCase()) || normalizedSchedule[0];
    const lessonNames = (todayEntry && Array.isArray(todayEntry.lessons) ? todayEntry.lessons : []).slice(0, 3).map((lesson) => lesson.name || 'Class');
    if (lessonNames.length) {
      parts.push(`Schedule: ${lessonNames.join(' • ')}`);
    }
  }

  const gradeList = Array.isArray(grades) ? grades.map((grade) => grade.value || grade.name || grade.grade || 'Grade') : [];
  if (gradeList.length) {
    parts.push(`Grades: ${gradeList.slice(0, 3).join(', ')}`);
  }

  const notificationList = Array.isArray(notifications) ? notifications.map((entry) => entry.title || entry.name || entry.message || entry.content || 'Notification') : [];
  if (notificationList.length) {
    parts.push(`Notifications: ${notificationList.slice(0, 2).join(' • ')}`);
  }

  const announcementList = Array.isArray(announcements) ? announcements.map((entry) => entry.title || entry.name || entry.message || entry.content || 'Announcement') : [];
  if (announcementList.length) {
    parts.push(`Announcements: ${announcementList.slice(0, 2).join(' • ')}`);
  }

  return parts.length ? parts.join(' • ') : 'School day overview: no items yet.';
}

function summarizeLibrusNotifications(notifications, limit = 5) {
  const items = Array.isArray(notifications) ? notifications : Object.values(notifications || {});
  return items
    .flat()
    .filter(Boolean)
    .slice(0, limit)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const title = item.title || item.name || item.subject || 'Notification';
        const message = item.message || item.content || item.text || item.body || '';
        return message ? `${title}: ${message}` : title;
      }
      return String(item);
    })
    .filter(Boolean);
}

async function fetchLibrusData({ login, password }) {
  if (!LibrusApi) {
    throw new Error('librus-api package is not installed in this environment.');
  }

  if (!login || !password) {
    throw new Error('Librus login and password are required.');
  }

  const client = new LibrusApi();
  await client.authorize(String(login), String(password));

  const [timetable, notifications, accountInfo, announcements, grades] = await Promise.all([
    client.calendar.getTimetable().catch(() => []),
    client.info.getNotifications().catch(() => []),
    client.info.getAccountInfo().catch(() => null),
    client.inbox.listAnnouncements().catch(() => []),
    client.info.getGrades().catch(() => [])
  ]);

  return {
    timetable,
    notifications,
    accountInfo,
    announcements,
    grades,
    normalizedTimetable: normalizeTimetableData(timetable)
  };
}

function toSchedulePayload(timetableData) {
  return normalizeTimetableData(timetableData);
}

module.exports = {
  LibrusApi,
  normalizeSingleLesson,
  normalizeTimetableData,
  buildMorningSummary,
  buildSchoolDaySummary,
  summarizeLibrusNotifications,
  fetchLibrusData,
  toSchedulePayload
};
