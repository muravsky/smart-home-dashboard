const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getSettings } = require('../db');

const DEFAULT_GEMINI_SYSTEM_PROMPT = `You are the smart assistant for a family smart home tablet dashboard. Today is ${new Date().toISOString().slice(0, 10)}.
Analyze the user's natural language input and return ONLY raw JSON matching this schema:
{
  "notes": ["string of note content"],
  "tasks": [
    {
      "title": "string",
      "assignee": "string or null",
      "reward": 0,
      "due_date": "YYYY-MM-DD or null",
      "due_time": "HH:MM or null",
      "recurrence": "none|daily|weekly|weekdays|weekends|interval",
      "recurrence_interval": 1,
      "action": "add"
    }
  ],
  "shopping_items": [
    {
      "content": "string (e.g. milk, eggs)",
      "action": "add"
    }
  ],
  "calendar_events": [
    {
      "title": "string",
      "date": "YYYY-MM-DD",
      "time": "HH:MM or null",
      "all_day": false
    }
  ],
  "timer": {
    "action": "start",
    "minutes": 5
  },
  "response_message": "Friendly 1-line confirmation of what was created or done"
}

Rules:
1. Shopping items: If the user mentions groceries, shopping, buy X, need X, put them in shopping_items.
2. Calendar events: If user mentions an appointment, meeting, practice, schedule, event with a date or time, put them in calendar_events with accurate ISO date (e.g. tomorrow = calculate relative to today).
3. Timer: If user says "set timer for 10 minutes", populate timer object (minutes as number).
4. Tasks: Chores, to-dos, things to do. If reward is mentioned (e.g. "for 15 points"), set reward number. If the user mentions a date or time, fill due_date and due_time. If they say recurring, use recurrence and recurrence_interval.
5. Notes: Generic info, reminders, thoughts.
6. Only return non-empty arrays/objects when detected. If a field is not present, use empty array [] or null for timer. If the request is not clearly actionable, return notes with the user text as a reminder.`;

const DEFAULT_GEMINI_TEXT_PROMPT = 'Extract actionable family dashboard items from the message and return only the structured JSON schema described above.';
const DEFAULT_GEMINI_VOICE_PROMPT = 'Please listen carefully to this voice recording, transcribe it, and extract the smart home actions according to the schema.';

function resolveGeminiPromptSettings() {
  const settings = getSettings ? getSettings() : {};
  return {
    system: String(settings.gemini_system_prompt || '').trim() || DEFAULT_GEMINI_SYSTEM_PROMPT,
    text: String(settings.gemini_text_prompt || '').trim() || DEFAULT_GEMINI_TEXT_PROMPT,
    voice: String(settings.gemini_voice_prompt || '').trim() || DEFAULT_GEMINI_VOICE_PROMPT
  };
}

function buildSystemPrompt(mode = 'text', senderName = null) {
  const { system, text, voice } = resolveGeminiPromptSettings();
  const basePrompt = mode === 'voice' ? voice : text;
  let prompt = `${system}\n\n${basePrompt}`;
  if (senderName) {
    prompt += `\nThe sender's name is ${senderName}.`;
  }
  return prompt;
}

function normalizeParsedGeminiPayload(parsed = {}) {
  const toArray = (value) => Array.isArray(value) ? value : [];

  const normalizedTasks = toArray(parsed.tasks).map((task) => {
    if (typeof task === 'string') {
      return {
        title: task.trim(),
        assignee: null,
        reward: 0,
        due_date: null,
        due_time: null,
        recurrence: 'none',
        recurrence_interval: 1
      };
    }

    const title = String(task.title || task.content || task.name || '').trim();
    if (!title) return null;

    return {
      title,
      assignee: task.assignee ? String(task.assignee).trim() || null : null,
      reward: Number(task.reward ?? task.points ?? 0) || 0,
      due_date: task.due_date || task.date || null,
      due_time: task.due_time || task.time || null,
      recurrence: task.recurrence || 'none',
      recurrence_interval: Number(task.recurrence_interval || task.interval || 1) || 1,
      recurrence_days: Array.isArray(task.recurrence_days) ? task.recurrence_days : (
        task.recurrence_days ? [task.recurrence_days] : null
      )
    };
  }).filter(Boolean);

  const normalizedShoppingItems = toArray(parsed.shopping_items).map((item) => {
    if (typeof item === 'string') {
      return { content: item.trim() };
    }
    const content = String(item.content || item.name || '').trim();
    return content ? { content } : null;
  }).filter(Boolean);

  const normalizedCalendarEvents = toArray(parsed.calendar_events).map((event) => {
    if (typeof event === 'string') {
      return { title: event.trim(), date: null, time: null, all_day: false };
    }
    const title = String(event.title || event.name || '').trim();
    if (!title) return null;
    return {
      title,
      date: event.date || null,
      time: event.time || null,
      all_day: Boolean(event.all_day)
    };
  }).filter(Boolean);

  const normalizedNotes = toArray(parsed.notes).map((note) => String(note || '').trim()).filter(Boolean);

  let timer = null;
  if (parsed.timer && typeof parsed.timer === 'object') {
    const minutes = Number(parsed.timer.minutes ?? parsed.timer.duration ?? 0);
    if (minutes > 0) {
      timer = {
        action: parsed.timer.action || 'start',
        minutes
      };
    }
  }

  return {
    notes: normalizedNotes,
    tasks: normalizedTasks,
    shopping_items: normalizedShoppingItems,
    calendar_events: normalizedCalendarEvents,
    timer,
    response_message: typeof parsed.response_message === 'string' ? parsed.response_message : ''
  };
}

/**
 * Parse incoming text from Telegram or Dictation using Gemini 3.5 Flash.
 */
async function parseTextWithGemini(userText, senderName = null) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('[Gemini] GEMINI_API_KEY is not configured in .env');
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const prompt = buildSystemPrompt('text', senderName);

  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    systemInstruction: prompt,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  });

  const response = await model.generateContent(userText);
  let rawContent = response.response.text().trim();

  // Strip markdown code fence if present
  rawContent = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const parsed = JSON.parse(rawContent);
  return normalizeParsedGeminiPayload(parsed);
}

/**
 * Parse incoming voice audio from Telegram using Gemini 3.5 Flash multimodal understanding.
 */
async function parseAudioWithGemini(audioBuffer, mimeType = 'audio/ogg', senderName = null) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('[Gemini] GEMINI_API_KEY is not configured in .env');
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const prompt = buildSystemPrompt('voice', senderName);

  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    systemInstruction: prompt,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  });

  const base64Audio = audioBuffer.toString('base64');
  const response = await model.generateContent([
    {
      inlineData: {
        mimeType: mimeType,
        data: base64Audio
      }
    },
    buildSystemPrompt('voice', senderName)
  ]);

  let rawContent = response.response.text().trim();
  rawContent = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const parsed = JSON.parse(rawContent);
  return normalizeParsedGeminiPayload(parsed);
}

module.exports = {
  buildSystemPrompt,
  normalizeParsedGeminiPayload,
  parseTextWithGemini,
  parseAudioWithGemini
};
