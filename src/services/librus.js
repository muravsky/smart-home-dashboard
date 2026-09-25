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
  const replacementTeacher = source.replacementTeacher || source.replacement_teacher || source.substituteTeacher || source.substitute_teacher || null;
  const replacement = Boolean(source.replacement || source.is_replacement || source.substitute || replacementTeacher || source.flag === 'replacement' || source.flag === 'zastępstwo');

  return {
    number: Number(source.number || source.no || idx + 1) || idx + 1,
    start,
    end,
    time,
    name: String(name).trim() || `Lesson ${idx + 1}`,
    room: String(room).trim() || '—',
    teacher: teacher ? String(teacher).trim() : null,
    replacementTeacher: replacementTeacher ? String(replacementTeacher).trim() : null,
    replacement,
    cancelled: Boolean(source.cancelled || source.canceled || source.flag === 'odwołane' || source.flag === 'cancelled' || source.flag === 'canceled'),
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

const SUMMARY_TEXT = {
  en: {
    weather: 'Weather',
    tasks: 'Tasks',
    schedule: 'Schedule',
    grades: 'Grades',
    notifications: 'Notifications',
    announcements: 'Announcements',
    today: 'today',
    noData: 'School day overview: no items yet.',
    noLessons: 'No lessons scheduled for',
    lesson: 'lesson',
    lessons: 'lessons',
    cancelled: 'cancelled',
    replacement: 'replacement teacher',
    author: 'Author',
    date: 'Date',
    time: 'Time',
    dressWarm: 'Dress warmly',
    snowExpected: 'Snow is expected today.',
    coolWeather: 'It is cold outside, so keep your layers on.',
    firstLesson: 'Your first lesson is',
    takeBooks: 'Take books for',
    homeTasks: 'You have home tasks planned',
    goodJob: 'You did great yesterday with',
    schoolPlan: 'Here is your school plan for today:'
  },
  pl: {
    weather: 'Pogoda',
    tasks: 'Zadania',
    schedule: 'Plan lekcji',
    grades: 'Oceny',
    notifications: 'Powiadomienia',
    announcements: 'Ogłoszenia',
    today: 'dziś',
    noData: 'Podsumowanie dnia szkolnego: brak danych.',
    noLessons: 'Brak lekcji na',
    lesson: 'lekcja',
    lessons: 'lekcje',
    cancelled: 'odwołana',
    replacement: 'zastępstwo',
    author: 'Autor',
    date: 'Data',
    time: 'Godzina',
    dressWarm: 'Ubierz się ciepło',
    snowExpected: 'Dziś spodziewany jest śnieg.',
    coolWeather: 'Na zewnątrz jest zimno, więc miej ciepłe warstwy.',
    firstLesson: 'Twoja pierwsza lekcja to',
    takeBooks: 'Zabierz książki do',
    homeTasks: 'Masz zaplanowane zadania domowe',
    goodJob: 'Dzisiaj dobrze sobie poradziłeś z',
    schoolPlan: 'To jest twój plan na dziś:'
  },
  ru: {
    weather: 'Погода',
    tasks: 'Задачи',
    schedule: 'Расписание',
    grades: 'Оценки',
    notifications: 'Уведомления',
    announcements: 'Объявления',
    today: 'сегодня',
    noData: 'Итог школьного дня: данных пока нет.',
    noLessons: 'Нет занятий на',
    lesson: 'урок',
    lessons: 'уроки',
    cancelled: 'отменено',
    replacement: 'замена',
    author: 'Автор',
    date: 'Дата',
    time: 'Время',
    dressWarm: 'Одевайся тепло',
    snowExpected: 'Сегодня ожидается снег.',
    coolWeather: 'На улице холодно, держи слои одежды.',
    firstLesson: 'Твой первый урок —',
    takeBooks: 'Возьми книги для',
    homeTasks: 'У тебя запланированы домашние задания',
    goodJob: 'Ты молодец, вчера были оценки',
    schoolPlan: 'Вот твой план на сегодня:'
  },
  uk: {
    weather: 'Погода',
    tasks: 'Завдання',
    schedule: 'Розклад',
    grades: 'Оцінки',
    notifications: 'Сповіщення',
    announcements: 'Оголошення',
    today: 'сьогодні',
    noData: 'Підсумок шкільного дня: даних поки немає.',
    noLessons: 'Немає уроків на',
    lesson: 'урок',
    lessons: 'уроки',
    cancelled: 'скасовано',
    replacement: 'заміна',
    author: 'Автор',
    date: 'Дата',
    time: 'Час',
    dressWarm: 'Одягайся тепло',
    snowExpected: 'Сьогодні очікується сніг.',
    coolWeather: 'На вулиці холодно, тримайся кількох шарів одягу.',
    firstLesson: 'Твій перший урок —',
    takeBooks: 'Візьми книги для',
    homeTasks: 'У тебе заплановані домашні завдання',
    goodJob: 'Ти молодець, вчора були оцінки',
    schoolPlan: 'Ось твій план на сьогодні:'
  }
};

function normalizeLanguage(language = 'en') {
  const lang = String(language || 'en').toLowerCase();
  return SUMMARY_TEXT[lang] ? lang : 'en';
}

function normalizeAnnouncement(item = {}) {
  if (!item || typeof item !== 'object') return null;
  const title = item.title || item.name || item.subject || item.message || item.content || 'Announcement';
  const author = item.author || item.publisher || item.created_by || item.createdBy || null;
  const date = item.date || item.created_at || item.createdAt || item.dateAdded || null;
  const time = item.time || item.time_created || item.created_time || item.createdTime || null;
  return {
    title: String(title).trim() || 'Announcement',
    author: author ? String(author).trim() : null,
    date: date ? String(date).trim() : null,
    time: time ? String(time).trim() : null,
    message: item.message || item.content || item.text || item.body || null
  };
}

function cleanList(values) {
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function buildSchoolDaySummary({ weather = null, tasks = [], schedule = [], grades = [], notifications = [], announcements = [], language = 'en' } = {}) {
  const lang = normalizeLanguage(language);
  const labels = SUMMARY_TEXT[lang];
  const parts = [];

  const normalizedSchedule = normalizeTimetableData(schedule);
  const today = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayLabel = dayNames[today.getDay()];
  const todayEntry = normalizedSchedule.find((entry) => String(entry.day).toLowerCase() === todayLabel.toLowerCase()) || normalizedSchedule[0];
  const lessons = Array.isArray(todayEntry && todayEntry.lessons) ? todayEntry.lessons.filter(Boolean) : [];
  const lessonNames = lessons.map((lesson) => lesson.name || lesson.subject || '').filter(Boolean);

  if (weather) {
    const temp = Number(weather.temperature ?? weather.temp ?? weather.current ?? 0);
    const condition = String(weather.condition || weather.summary || labels.weather || '').trim();
    const tempText = Number.isFinite(temp) ? `${Math.round(temp)}°` : '—';
    const lowerCondition = condition.toLowerCase();
    const coldWeather = Number.isFinite(temp) && temp <= 5;
    const snowWeather = /snow|sleet|storm|freez|cold/.test(lowerCondition) || coldWeather;

    if (snowWeather) {
      parts.push(`${labels.dressWarm} — ${labels.snowExpected}`);
    } else if (coldWeather || (Number.isFinite(temp) && temp < 12)) {
      parts.push(`${labels.dressWarm} — ${labels.coolWeather}`);
    } else {
      parts.push(`${labels.weather}: ${tempText} ${condition || labels.weather}`);
    }
  }

  if (lessons.length) {
    const firstLesson = lessons[0];
    const firstName = firstLesson.name || firstLesson.subject || labels.lesson;
    const firstTime = firstLesson.start ? (firstLesson.end ? `${firstLesson.start}-${firstLesson.end}` : firstLesson.start) : '';
    parts.push(`${labels.firstLesson} ${firstName}${firstTime ? ` (${firstTime})` : ''}.`);
    if (lessonNames.length > 1) {
      parts.push(`${labels.takeBooks} ${lessonNames.slice(0, 3).join(', ')}.`);
    }
  }

  const taskList = cleanList(Array.isArray(tasks) ? tasks : []).map((task) => task.content || task.title || task.name || 'Task');
  if (taskList.length) {
    parts.push(`${labels.homeTasks}: ${taskList.slice(0, 2).join(', ')}.`);
  }

  const gradeList = cleanList(Array.isArray(grades) ? grades : []).map((grade) => grade.value || grade.name || grade.grade || grade.subject || 'Grade');
  if (gradeList.length) {
    parts.push(`${labels.goodJob} ${gradeList.slice(0, 2).join(', ')}.`);
  }

  const notificationList = cleanList(Array.isArray(notifications) ? notifications : []).map((entry) => entry.title || entry.name || entry.message || entry.content || 'Notification');
  if (notificationList.length) {
    parts.push(`${labels.notifications}: ${notificationList.slice(0, 2).join(' • ')}.`);
  }

  const announcementList = cleanList(Array.isArray(announcements) ? announcements : []).map((entry) => normalizeAnnouncement(entry));
  if (announcementList.length) {
    const summary = announcementList.slice(0, 2).map((item) => {
      const meta = [item.author, item.date, item.time].filter(Boolean).join(' • ');
      return meta ? `${item.title} (${meta})` : item.title;
    });
    parts.push(`${labels.announcements}: ${summary.join(' • ')}.`);
  }

  return parts.length ? `${labels.schoolPlan} ${parts.join(' ')}` : labels.noData;
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
