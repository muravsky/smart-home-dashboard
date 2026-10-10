const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getSettings, getProfiles, getLists } = require('../db');

const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const FALLBACK_GEMINI_MODELS = [
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Next generation fast multimodal model' },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', description: 'Fast and versatile performance across tasks' },
  { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash (Latest)', description: 'Latest stable 1.5 flash release' },
  { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash-8B', description: 'High volume and lower latency' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Complex reasoning and multimodal understanding' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Advanced adaptive flash model' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'High capability pro model' }
];

function getGeminiModel() {
  const settings = typeof getSettings === 'function' ? getSettings() : {};
  return (settings && settings.gemini_model) || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

async function listAvailableGeminiModels(apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) {
    return FALLBACK_GEMINI_MODELS;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Gemini] Failed to fetch models list from Google API (${res.status} ${res.statusText}), using fallback models`);
      return FALLBACK_GEMINI_MODELS;
    }

    const data = await res.json();
    if (!data || !Array.isArray(data.models)) {
      return FALLBACK_GEMINI_MODELS;
    }

    const contentModels = data.models.filter(m => {
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      return methods.includes('generateContent');
    });

    if (contentModels.length === 0) {
      return FALLBACK_GEMINI_MODELS;
    }

    return contentModels.map(m => {
      const cleanId = (m.name || '').replace(/^models\//, '');
      return {
        id: cleanId,
        name: m.displayName || cleanId,
        description: m.description || ''
      };
    });
  } catch (err) {
    console.warn('[Gemini] Error listing models:', err.message);
    return FALLBACK_GEMINI_MODELS;
  }
}

const DEFAULT_GEMINI_SYSTEM_PROMPT = `You are the smart assistant for a family smart home tablet dashboard. Today is ${new Date().toISOString().slice(0, 10)}.
Analyze the user's natural language input and return ONLY raw JSON matching this schema:
/* Base schema: { "notes": ["string"], "tasks": [{ "assignee": "string", "title": "string", "reward": number }] } */
{
  "notes": ["string of note content"],
  "tasks": [
    {
      "title": "string",
      "assignee": "string or null",
      "reward": 0,
      "due_date": "YYYY-MM-DD or null",
      "due_time": "HH:MM or null",
      "recurrence": "none|daily|weekly|weekdays|weekends|interval|monthly|yearly",
      "recurrence_interval": 1,
      "recurrence_days": ["Mon", "Wed"] or null,
      "action": "add"
    }
  ],
  "shopping_items": [
    {
      "content": "string (e.g. milk, eggs)",
      "assignee": "string or null",
      "list_name": "string or null",
      "recurrence": "none|daily|weekly|interval|monthly",
      "recurrence_interval": 1,
      "action": "add"
    }
  ],
  "calendar_events": [
    {
      "title": "string",
      "date": "YYYY-MM-DD",
      "time": "HH:MM or null",
      "all_day": false,
      "person": "string or null",
      "recurrence": "none|daily|weekly|monthly|yearly",
      "recurrence_interval": 1
    }
  ],
  "timer": {
    "action": "start",
    "minutes": 5
  },
  "response_message": "Friendly 1-line confirmation of what was created or done"
}

Rules:
1. Shopping items: If the user mentions groceries, shopping, buy X, need X, put them in shopping_items. If they mention a specific shopping list (e.g. Costco, Hardware store, Groceries), put it in list_name. If they mention who requested it or who should buy it, put it in assignee (or null for the whole family). If recurring (e.g. buy milk every week), set recurrence.
2. Calendar events: If user mentions an appointment, meeting, practice, schedule, event with a date or time, put them in calendar_events with accurate ISO date (e.g. tomorrow = calculate relative to today). If the event is for a specific family member, set person to their name. If it is for the whole family or everyone, set person to null or "family". If recurring (e.g. every Tuesday, every week), set recurrence and recurrence_interval.
3. Timer: If user says "set timer for 10 minutes", populate timer object (minutes as number).
4. Tasks: Chores, to-dos, things to do. If a specific family member is responsible, set assignee to their name. If the task is for everyone / the whole family or unassigned, set assignee to null. If reward is mentioned (e.g. "for 15 points"), set reward number. If date/time mentioned, fill due_date and due_time. If recurring, set recurrence (e.g. daily, weekly, weekdays, weekends) and recurrence_interval.
5. Notes: Generic info, reminders, thoughts.
6. Only return non-empty arrays/objects when detected. If a field is not present, use empty array [] or null for timer. If the request is not clearly actionable, return notes with the user text as a reminder.`;

const DEFAULT_GEMINI_TEXT_PROMPT = 'Extract actionable family dashboard items from the message and return only the structured JSON schema described above.';
const DEFAULT_GEMINI_VOICE_PROMPT = 'Please listen carefully to this voice recording, transcribe it, and extract the smart home actions according to the schema.';
const DEFAULT_GEMINI_SUMMARY_PROMPT = `You are a cheerful school-day helper for a family dashboard. Read the full context below and write a short, warm, and relevant summary for the child in the requested language. Include weather, first lesson, required materials, chores/todos, reminders, and school notices only when they are actually present. Do not invent missing facts. Keep it encouraging and human, like a caring parent or teacher. Return plain text only, no JSON, no markdown.`;

function resolveGeminiPromptSettings() {
  const settings = typeof getSettings === 'function' ? getSettings() : {};
  return {
    system: String(settings.gemini_system_prompt || '').trim() || DEFAULT_GEMINI_SYSTEM_PROMPT,
    text: String(settings.gemini_text_prompt || '').trim() || DEFAULT_GEMINI_TEXT_PROMPT,
    voice: String(settings.gemini_voice_prompt || '').trim() || DEFAULT_GEMINI_VOICE_PROMPT,
    summary: String(settings.gemini_summary_prompt || '').trim() || DEFAULT_GEMINI_SUMMARY_PROMPT
  };
}

function buildSystemPrompt(mode = 'text', senderName = null) {
  const { system, text, voice } = resolveGeminiPromptSettings();
  const basePrompt = mode === 'voice' ? voice : text;
  let prompt = `${system}\n\n${basePrompt}`;
  if (senderName) {
    prompt += `\nThe sender's name is ${senderName}.`;
  }

  // Inject current family profiles if available
  try {
    const profiles = typeof getProfiles === 'function' ? getProfiles() : [];
    if (profiles && profiles.length > 0) {
      const names = profiles.map(p => `- ${p.name || 'Member'} (ID: ${p.id})`).join('\n');
      prompt += `\n\nRegistered family members:\n${names}\n(Use exact name for assignee/person, or null/"family" if for the whole family)`;
    }
  } catch (e) {}

  // Inject existing lists if available
  try {
    const lists = typeof getLists === 'function' ? getLists() : [];
    if (lists && lists.length > 0) {
      const listNames = lists.map(l => `- ${l.name} (type: ${l.type})`).join('\n');
      prompt += `\n\nExisting dashboard lists:\n${listNames}`;
    }
  } catch (e) {}

  return prompt;
}

function normalizeParsedGeminiPayload(parsed = {}) {
  const toArray = (value) => Array.isArray(value) ? value : [];

  const cleanAssignee = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const lower = s.toLowerCase();
    if (['family', 'all', 'everyone', 'entire family', 'whole family', 'everybody'].includes(lower)) {
      return null;
    }
    return s;
  };

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
      assignee: cleanAssignee(task.assignee),
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
      return {
        content: item.trim(),
        assignee: null,
        list_name: null,
        recurrence: 'none',
        recurrence_interval: 1
      };
    }
    const content = String(item.content || item.name || '').trim();
    if (!content) return null;
    return {
      content,
      assignee: cleanAssignee(item.assignee),
      list_name: item.list_name ? String(item.list_name).trim() : null,
      recurrence: item.recurrence || 'none',
      recurrence_interval: Number(item.recurrence_interval || 1) || 1
    };
  }).filter(Boolean);

  const normalizedCalendarEvents = toArray(parsed.calendar_events).map((event) => {
    if (typeof event === 'string') {
      return { title: event.trim(), date: null, time: null, all_day: false, person: null, recurrence: 'none', recurrence_interval: 1 };
    }
    const title = String(event.title || event.name || '').trim();
    if (!title) return null;
    return {
      title,
      date: event.date || null,
      time: event.time || null,
      all_day: Boolean(event.all_day),
      person: cleanAssignee(event.person || event.assignee),
      recurrence: event.recurrence || 'none',
      recurrence_interval: Number(event.recurrence_interval || 1) || 1
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

async function generateSchoolDaySummaryWithGemini(context = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const { summary } = resolveGeminiPromptSettings();
  const language = String(context.language || 'en').trim() || 'en';
  const profileName = String(context.profile_name || context.profileName || 'kid').trim() || 'kid';
  const payload = JSON.stringify({
    language,
    profile_name: profileName,
    weather: context.weather || null,
    tasks: Array.isArray(context.tasks) ? context.tasks : [],
    schedule: Array.isArray(context.schedule) ? context.schedule : [],
    grades: Array.isArray(context.grades) ? context.grades : [],
    notifications: Array.isArray(context.notifications) ? context.notifications : [],
    announcements: Array.isArray(context.announcements) ? context.announcements : []
  }, null, 2);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: getGeminiModel(),
      systemInstruction: summary,
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'text/plain'
      }
    });

    const response = await model.generateContent(`Language: ${language}\nProfile: ${profileName}\nContext:\n${payload}`);
    const rawText = response.response.text ? response.response.text() : String(response || '');
    const summaryText = String(rawText || '').trim();
    return summaryText || null;
  } catch (error) {
    console.warn('[Gemini] School summary generation failed:', error.message || error);
    return null;
  }
}

/**
 * Parse incoming text from Telegram or Dictation using Gemini.
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
    model: getGeminiModel(),
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
 * Parse incoming voice audio from Telegram using Gemini multimodal understanding.
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
    model: getGeminiModel(),
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

const SYSTEM_PROMPT = DEFAULT_GEMINI_SYSTEM_PROMPT;

module.exports = {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODELS,
  DEFAULT_GEMINI_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  getGeminiModel,
  listAvailableGeminiModels,
  buildSystemPrompt,
  normalizeParsedGeminiPayload,
  generateSchoolDaySummaryWithGemini,
  parseTextWithGemini,
  parseAudioWithGemini
};
