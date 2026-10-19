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

function addMinutesToTime(timeString, minutesToAdd) {
  if (!timeString || !/^\d{1,2}:\d{2}$/.test(String(timeString).trim())) {
    return timeString || '08:00';
  }

  const [hours, mins] = String(timeString).trim().split(':').map(Number);
  const total = hours * 60 + mins + minutesToAdd;
  const nextHours = Math.floor(total / 60) % 24;
  const nextMinutes = total % 60;
  return `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}`;
}

function isSchoolDayName(value) {
  if (!value) return false;
  const day = String(value).trim().toLowerCase();
  return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].includes(day);
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

  if (typeof rawTime === 'string' && /^\d{1,2}:\d{2}$/.test(rawTime.trim())) {
    const start = rawTime.trim();
    return { start, end: addMinutesToTime(start, 45), time: start };
  }

  return fallback;
}

function extractTimeFromHours(hours, lesson, idx = 0) {
  if (!Array.isArray(hours) || hours.length === 0) return null;

  const lessonNumber = Number(lesson && (lesson.number || lesson.no || lesson.lessonNumber || lesson.hour || lesson.period || lesson.index || idx + 1));
  const slotIndex = Number.isFinite(lessonNumber) && lessonNumber > 0 ? lessonNumber - 1 : idx;
  const slot = hours[slotIndex] || hours[idx] || hours[0];
  if (!slot) return null;

  if (typeof slot === 'string') {
    if (slot.includes('-')) {
      const [start, end] = slot.split('-').map((p) => p.trim()).filter(Boolean);
      if (start && end) return { start, end, time: slot };
    }
    if (slot.includes(' ')) {
      const [start, end] = slot.split(' ').map((p) => p.trim()).filter(Boolean);
      if (start && end) return { start, end, time: slot };
    }
    if (slot.length >= 5) {
      return { start: slot.slice(0, 5), end: slot.slice(0, 5), time: slot };
    }
  }

  if (slot && typeof slot === 'object') {
    const start = slot.start || slot.from || slot.begin || slot.time_start || slot.timeStart || null;
    const end = slot.end || slot.to || slot.finish || slot.time_end || slot.timeEnd || null;
    if (start && end) return { start: String(start).slice(0, 5), end: String(end).slice(0, 5), time: `${start}-${end}` };
  }

  return null;
}

function hasMarker(value) {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && /^(?:true|1|yes|tak)$/i.test(value.trim());
}

function normalizeSingleLesson(lesson, idx = 0, hours = []) {
  const source = lesson || {};
  const timeFromHours = extractTimeFromHours(hours, source, idx);
  const { start, end, time } = timeFromHours || parseLessonTime(source);
  const name = source.subject || source.name || source.title || `Lesson ${idx + 1}`;
  const room = source.room || source.classroom || source.className || source.clazz || '—';
  const teacher = source.teacher || source.teacherName || source.instructor || null;
  const replacementTeacher = source.replacementTeacher || source.replacement_teacher || source.substituteTeacher || source.substitute_teacher || null;
  const flag = [source.flag, source.status, source.changeType, source.change_type].filter(Boolean).join(', ');
  const replacement = hasMarker(source.replacement) || hasMarker(source.is_replacement) || hasMarker(source.substitute) || Boolean(replacementTeacher || source.original) || /replacement|zastęp|zastep/i.test(flag);
  const cancelled = [source.cancelled, source.canceled, source.isCancelled, source.isCanceled, source.is_cancelled, source.is_canceled].some(hasMarker) || /odwoł|odwol|cancel/i.test(flag);
  const moved = [source.moved, source.isMoved, source.rescheduled, source.is_rescheduled].some(hasMarker) || Boolean(source.original) || /przen|zmian|move|resched/i.test(flag);

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
    cancelled,
    moved,
    flag: flag || null,
    original: source.original || null,
    date: source.date ? String(source.date) : null
  };
}

const SCHOOL_DAYS_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function formatIsoDateLocal(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getWeekBounds(referenceDate = new Date(), weekOffset = 0) {
  const base = referenceDate instanceof Date ? new Date(referenceDate.getTime()) : new Date(referenceDate);
  base.setHours(12, 0, 0, 0);
  const daysSinceMonday = (base.getDay() + 6) % 7;
  const monday = new Date(base);
  monday.setDate(base.getDate() - daysSinceMonday + (weekOffset * 7));

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const dayDates = {};
  SCHOOL_DAYS_ORDER.forEach((dayName, idx) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + idx);
    dayDates[dayName] = formatIsoDateLocal(d);
  });

  return {
    from: formatIsoDateLocal(monday),
    to: formatIsoDateLocal(sunday),
    dayDates
  };
}

function stripOneOffLessonChanges(lessons = []) {
  if (!Array.isArray(lessons)) return [];
  return lessons.map((lesson) => ({
    ...lesson,
    replacementTeacher: null,
    replacement: false,
    moved: false,
    cancelled: false,
    flag: null,
    original: null
  }));
}

function parseSingleWeekTable(rawTimetable, weekDates = {}) {
  if (!rawTimetable) return [];
  const hours = Array.isArray(rawTimetable.hours)
    ? rawTimetable.hours
    : Array.isArray(rawTimetable.time_slots)
      ? rawTimetable.time_slots
      : [];
  const sourceTable = rawTimetable.table || rawTimetable.days || rawTimetable;

  if (Array.isArray(sourceTable)) {
    return sourceTable
      .map((dayEntry, index) => {
        const dayName = dayEntry && (dayEntry.day || dayEntry.name || dayEntry.label)
          ? String(dayEntry.day || dayEntry.name || dayEntry.label)
          : `Day ${index + 1}`;
        const lessons = Array.isArray(dayEntry && dayEntry.lessons)
          ? dayEntry.lessons
          : Array.isArray(dayEntry)
            ? dayEntry
            : [];
        if (!isSchoolDayName(dayName)) return null;
        const displayDay = toDisplayDayName(dayName);
        const dayDate = (dayEntry && dayEntry.date) || weekDates[displayDay] || null;
        const normalizedLessons = lessons.map((lesson, lessonIndex) => {
          const norm = normalizeSingleLesson(lesson, lessonIndex, hours);
          if (dayDate && !norm.date) norm.date = dayDate;
          return norm;
        });
        const result = {
          day: displayDay,
          lessons: normalizedLessons
        };
        if (dayDate) result.date = dayDate;
        if (dayEntry && dayEntry.nextDate) result.nextDate = String(dayEntry.nextDate);
        if (Array.isArray(dayEntry && dayEntry.nextLessons)) {
          result.nextLessons = dayEntry.nextLessons.map((lesson, lessonIndex) => {
            const norm = normalizeSingleLesson(lesson, lessonIndex, hours);
            if (dayEntry.nextDate && !norm.date) norm.date = String(dayEntry.nextDate);
            return norm;
          });
        }
        return result;
      })
      .filter(Boolean);
  }

  if (sourceTable && typeof sourceTable === 'object') {
    return Object.entries(sourceTable)
      .map(([dayName, lessons]) => {
        if (!isSchoolDayName(dayName)) return null;
        const displayDay = toDisplayDayName(dayName);
        const dayDate = weekDates[displayDay] || null;
        return {
          day: displayDay,
          ...(dayDate ? { date: dayDate } : {}),
          lessons: Array.isArray(lessons)
            ? lessons.map((lesson, lessonIndex) => {
                const norm = normalizeSingleLesson(lesson, lessonIndex, hours);
                if (dayDate && !norm.date) norm.date = dayDate;
                return norm;
              })
            : []
        };
      })
      .filter(Boolean);
  }

  return [];
}

function normalizeTimetableData(rawTimetable, options = {}) {
  if (!rawTimetable) return [];

  const refDate = options.referenceDate ? new Date(options.referenceDate) : new Date();
  const currentWeek = getWeekBounds(refDate, 0);
  const nextWeek = getWeekBounds(refDate, 1);

  if (rawTimetable && typeof rawTimetable === 'object' && !Array.isArray(rawTimetable) && rawTimetable.nextWeek) {
    const currentDays = parseSingleWeekTable(rawTimetable.currentWeek || rawTimetable, rawTimetable.weekDates || currentWeek.dayDates);
    const nextDays = parseSingleWeekTable(rawTimetable.nextWeek, rawTimetable.nextWeekDates || nextWeek.dayDates);
    const nextByDay = Object.fromEntries(nextDays.map((d) => [d.day, d]));

    return currentDays.map((entry) => {
      const nextEntry = nextByDay[entry.day];
      return {
        ...entry,
        date: entry.date || currentWeek.dayDates[entry.day] || null,
        nextDate: (nextEntry && nextEntry.date) || nextWeek.dayDates[entry.day] || null,
        nextLessons: nextEntry && Array.isArray(nextEntry.lessons)
          ? nextEntry.lessons
          : stripOneOffLessonChanges(entry.lessons)
      };
    });
  }

  return parseSingleWeekTable(rawTimetable, options.weekDates || {});
}

function resolveLessonsForDate(dayEntry, targetDateIso) {
  if (!dayEntry) return [];
  if (targetDateIso && dayEntry.nextDate && dayEntry.nextDate === targetDateIso && Array.isArray(dayEntry.nextLessons)) {
    return dayEntry.nextLessons;
  }
  if (targetDateIso && dayEntry.date && dayEntry.date === targetDateIso) {
    return Array.isArray(dayEntry.lessons) ? dayEntry.lessons : [];
  }
  if (targetDateIso && dayEntry.date && targetDateIso > dayEntry.date) {
    if (Array.isArray(dayEntry.nextLessons) && dayEntry.nextLessons.length > 0) {
      return dayEntry.nextLessons;
    }
    return stripOneOffLessonChanges(dayEntry.lessons);
  }
  return Array.isArray(dayEntry.lessons) ? dayEntry.lessons : [];
}

function buildMorningSummary(person, timetableData, referenceDate = new Date()) {
  const name = (() => {
    if (!person) return 'Student';
    if (typeof person === 'string') return person.trim() || 'Student';
    return person.name || person.first_name || person.label || 'Student';
  })();

  const normalized = normalizeTimetableData(timetableData, { referenceDate });
  if (!normalized.length) {
    return `${name}'s school day: no lessons scheduled yet.`;
  }

  const today = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayLabel = dayNames[today.getDay()];
  const todayIso = formatIsoDateLocal(today);
  const todayEntry = normalized.find((entry) => String(entry.day).toLowerCase() === todayLabel.toLowerCase()) || normalized[0];
  const lessons = resolveLessonsForDate(todayEntry, todayIso);

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
  const author = item.author || item.user || item.publisher || item.created_by || item.createdBy || null;
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

function buildSchoolDaySummary({ weather = null, tasks = [], schedule = [], grades = [], notifications = [], announcements = [], language = 'en', referenceDate = new Date() } = {}) {
  const lang = normalizeLanguage(language);
  const labels = SUMMARY_TEXT[lang];
  const parts = [];

  const normalizedSchedule = normalizeTimetableData(schedule, { referenceDate });
  const today = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayLabel = dayNames[today.getDay()];
  const todayIso = formatIsoDateLocal(today);
  const todayEntry = normalizedSchedule.find((entry) => String(entry.day).toLowerCase() === todayLabel.toLowerCase()) || normalizedSchedule[0];
  const lessons = resolveLessonsForDate(todayEntry, todayIso).filter(Boolean);
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

function flattenLibrusGrades(rawGrades) {
  if (!Array.isArray(rawGrades)) return [];
  const flattened = [];
  for (const subjectRow of rawGrades) {
    if (!subjectRow || typeof subjectRow !== 'object') continue;
    (Array.isArray(subjectRow.semester) ? subjectRow.semester : []).forEach((semester, semesterIndex) => {
      (Array.isArray(semester && semester.grades) ? semester.grades : []).forEach((grade) => {
        if (!grade || typeof grade !== 'object') return;
        flattened.push({
          id: grade.id || null,
          subject: subjectRow.name || subjectRow.subject || 'School subject',
          semester: semesterIndex + 1,
          value: grade.value || grade.grade || '-',
          info: grade.info || '',
          date: grade.date || null
        });
      });
    });
    if (!Array.isArray(subjectRow.semester) && (subjectRow.value || subjectRow.grade)) {
      flattened.push({
        id: subjectRow.id || null,
        subject: subjectRow.subject || subjectRow.name || 'School subject',
        value: subjectRow.value || subjectRow.grade,
        date: subjectRow.date || null,
        info: subjectRow.info || subjectRow.comment || ''
      });
    }
  }
  return flattened;
}

async function hydrateGradeDetails(client, grades, errors) {
  const latest = grades.slice(-30);
  return Promise.all(latest.map(async (grade) => {
    if (!grade.id || grade.date) return grade;
    try {
      const detail = await client.info.getGrade(grade.id);
      return {
        ...grade,
        value: detail.grade || grade.value,
        date: detail.date || grade.date,
        category: detail.category || null,
        teacher: detail.teacher || null,
        comment: detail.comment || grade.info || null,
        lesson: detail.lesson || null
      };
    } catch (error) {
      errors.push({ resource: 'grade_detail', id: grade.id, message: error.message });
      return grade;
    }
  }));
}

async function fetchLibrusData({ login, password, resources = null, referenceDate = new Date() }) {
  if (!LibrusApi) {
    throw new Error('librus-api package is not installed in this environment.');
  }

  if (!login || !password) {
    throw new Error('Librus login and password are required.');
  }

  const client = new LibrusApi();
  await client.authorize(String(login), String(password));
  const fetchAll = !Array.isArray(resources);
  const shouldFetch = resource => fetchAll || resources.includes(resource);
  const errors = [];
  const fetchResource = async (name, request, fallback) => {
    try { return await request(); } catch (error) {
      errors.push({ resource: name, message: error.message });
      return fallback;
    }
  };

  const currentWeek = getWeekBounds(referenceDate, 0);
  const nextWeek = getWeekBounds(referenceDate, 1);

  const [currentTimetableRaw, nextTimetableRaw, notificationCounts, accountInfo, announcements, rawGrades, inboxHeaders] = await Promise.all([
    shouldFetch('timetable') ? fetchResource('timetable', () => client.calendar.getTimetable(currentWeek.from, currentWeek.to), []) : [],
    shouldFetch('timetable') ? fetchResource('timetable_next', async () => {
      try {
        return await client.calendar.getTimetable(nextWeek.from, nextWeek.to);
      } catch (e) {
        return null;
      }
    }, null) : null,
    shouldFetch('notifications') ? fetchResource('notification_counts', () => client.info.getNotifications(), {}) : {},
    fetchAll ? fetchResource('account', () => client.info.getAccountInfo(), null) : null,
    shouldFetch('announcements') ? fetchResource('announcements', () => client.inbox.listAnnouncements(), []) : [],
    shouldFetch('grades') ? fetchResource('grades', () => client.info.getGrades(), []) : [],
    shouldFetch('messages') ? fetchResource('inbox', () => client.inbox.listInbox(5), []) : []
  ]);

  let timetable = currentTimetableRaw;
  if (shouldFetch('timetable') && currentTimetableRaw && typeof currentTimetableRaw === 'object' && !Array.isArray(currentTimetableRaw)) {
    timetable = {
      ...currentTimetableRaw,
      weekDates: currentWeek.dayDates,
      nextWeek: nextTimetableRaw || null,
      nextWeekDates: nextWeek.dayDates
    };
  } else if (shouldFetch('timetable') && Array.isArray(currentTimetableRaw) && nextTimetableRaw) {
    timetable = {
      table: currentTimetableRaw,
      weekDates: currentWeek.dayDates,
      nextWeek: nextTimetableRaw,
      nextWeekDates: nextWeek.dayDates
    };
  }

  const grades = shouldFetch('grades') ? await hydrateGradeDetails(client, flattenLibrusGrades(rawGrades), errors) : [];
  const messages = shouldFetch('messages') ? await Promise.all((Array.isArray(inboxHeaders) ? inboxHeaders : []).slice(0, 20).map(async (header) => {
    if (!header || !header.id) return header;
    try {
      return { ...header, ...(await client.inbox.getMessage(5, header.id)) };
    } catch (error) {
      errors.push({ resource: 'message_detail', id: header.id, message: error.message });
      return header;
    }
  })) : [];
  const notifications = Object.entries(notificationCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([category, count]) => ({ id: category, category, count: Number(count), title: `${category}: ${count}` }));

  return {
    timetable,
    notifications,
    notificationCounts,
    messages,
    accountInfo,
    announcements,
    grades,
    errors,
    normalizedTimetable: normalizeTimetableData(timetable, { referenceDate })
  };
}

function toSchedulePayload(timetableData, options = {}) {
  return normalizeTimetableData(timetableData, options);
}

module.exports = {
  LibrusApi,
  getWeekBounds,
  resolveLessonsForDate,
  stripOneOffLessonChanges,
  normalizeSingleLesson,
  normalizeTimetableData,
  buildMorningSummary,
  buildSchoolDaySummary,
  summarizeLibrusNotifications,
  flattenLibrusGrades,
  fetchLibrusData,
  toSchedulePayload
};
