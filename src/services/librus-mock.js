function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatPolishDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function weekStart(date, offset = 0) {
  const monday = new Date(date);
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + offset * 7);
  return monday;
}

function createLocalLibrusMock(referenceDate = new Date()) {
  const currentMonday = weekStart(referenceDate);
  const nextMonday = weekStart(referenceDate, 1);
  const lessons = [
    { subject: 'Matematyka', teacher: 'Anna Kowalska', room: '12', time: '08:00-08:45' },
    { subject: 'Język polski', teacher: 'Jan Nowak', room: '8', time: '08:55-09:40' },
    { subject: 'Biologia', teacher: 'Maria Wiśniewska', room: '21', time: '09:50-10:35' }
  ];
  const eventDetails = [
    {
      id: 901,
      date: formatPolishDate(formatIsoDate(currentMonday)),
      lessonNumber: '1',
      teacher: 'Anna Kowalska',
      type: 'Praca domowa',
      subject: 'Matematyka',
      room: '12',
      description: 'Rozwiązać zadania 1–5 ze strony 42. Przynieść zeszyt ćwiczeń.'
    },
    {
      id: 902,
      date: formatPolishDate(formatIsoDate(currentMonday)),
      lessonNumber: '2',
      teacher: 'Jan Nowak',
      type: 'Notatka',
      subject: 'Język polski',
      room: '8',
      description: 'Zaplanowana praca klasowa z lektury. Powtórzyć rozdziały 4–7.'
    },
    {
      id: 903,
      date: formatPolishDate(formatIsoDate(new Date(currentMonday.getTime() + 86400000))),
      lessonNumber: '3',
      teacher: 'Maria Wiśniewska',
      type: 'Aktywność',
      subject: 'Biologia',
      room: '21',
      description: 'Praca w grupach: przygotować plakat o ekosystemach.'
    },
    {
      id: 904,
      date: formatPolishDate(formatIsoDate(nextMonday)),
      lessonNumber: '1',
      teacher: 'Anna Kowalska',
      type: 'Praca domowa',
      subject: 'Matematyka',
      room: '12',
      description: 'Przykładowa informacja z przyszłego tygodnia.'
    }
  ];
  const events = eventDetails.map(detail => ({
    id: detail.id,
    day: detail.date.split('.').reverse().join('-'),
    title: `${detail.type}: ${detail.subject}`
  }));

  function timetableForWeek() {
    const table = {};
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].forEach((day, index) => {
      table[day] = index < 2 ? lessons : [];
    });
    return { hours: lessons.map(lesson => lesson.time), table };
  }

  return {
    async authorize(login, password) {
      if (login !== 'demo' || password !== 'demo') {
        throw new Error('Local Librus demo account expects login "demo" and password "demo".');
      }
    },
    calendar: {
      async getTimetable(from) {
        const fromDate = new Date(`${from}T12:00:00`);
        const monday = fromDate <= weekStart(referenceDate, 0) ? currentMonday : nextMonday;
        return timetableForWeek(monday);
      },
      async getCalendar(month, year) {
        const prefix = `${year}-${String(month).padStart(2, '0')}-`;
        return events.filter(event => event.day.startsWith(prefix));
      },
      async getEvent(id) {
        return eventDetails.find(detail => detail.id === Number(id)) || null;
      }
    },
    info: {
      async getNotifications() { return {}; },
      async getAccountInfo() { return { name: 'Local Librus Demo', mock: true }; },
      async getGrades() { return []; }
    },
    inbox: {
      async listAnnouncements() { return []; },
      async listInbox() { return []; }
    }
  };
}

module.exports = { createLocalLibrusMock };
