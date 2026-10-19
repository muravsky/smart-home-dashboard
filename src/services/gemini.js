const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getSettings, getProfiles, getLists, getCalendarFeeds, getDishes, getDefaultMealSlots } = require('../db');

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
  "notes": ["string of note content OR object { action: 'add'|'edit'|'delete', content: 'string', match: 'string', id: number }"],
  "tasks": [
    {
      "title": "string",
      "new_title": "string or null (when action='edit')",
      "assignee": "string or null",
      "reward": 0,
      "due_date": "YYYY-MM-DD or null",
      "due_time": "HH:MM or null",
      "recurrence": "none|daily|weekly|weekdays|weekends|interval|monthly|yearly",
      "recurrence_interval": 1,
      "recurrence_days": ["Mon", "Wed"] or null,
      "action": "add|complete|edit|delete"
    }
  ],
  "shopping_items": [
    {
      "content": "string (e.g. milk, eggs, or item for any custom list)",
      "new_content": "string or null (when action='edit')",
      "assignee": "string or null",
      "list_name": "string or null (name of shopping or custom list)",
      "recurrence": "none|daily|weekly|interval|monthly",
      "recurrence_interval": 1,
      "action": "add|check|uncheck|edit|delete"
    }
  ],
  "calendar_events": [
    {
      "title": "string",
      "new_title": "string or null (when action='edit')",
      "date": "YYYY-MM-DD",
      "time": "HH:MM or null",
      "all_day": false,
      "person": "string or null",
      "recurrence": "none|daily|weekly|monthly|yearly",
      "recurrence_interval": 1,
      "action": "add|edit|delete"
    }
  ],
  "meal_actions": [
    {
      "action": "set_meal|add_dish|ingredients_to_shopping",
      "day": "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday or null",
      "slot": "Breakfast|Lunch|Dinner|Snack or custom slot name",
      "dish_name": "string",
      "ingredients": ["string"],
      "recipe": "string or null",
      "tags": ["string"]
    }
  ],
  "timer": {
    "action": "start",
    "minutes": 5
  },
  "response_message": "Friendly 1-line confirmation of what was created or done"
}

Rules:
1. Shopping & Custom List items: If the user mentions groceries, shopping, buy X, need X, OR mentions adding/checking/removing an item in any custom list (e.g. "add batteries to Hardware list", "check milk off shopping list", "remove bread from shopping list"), put them in shopping_items with the appropriate action ("add", "check", "uncheck", "edit", "delete") and list_name.
2. Calendar events vs Tasks:
   - Calendar events: If the user explicitly mentions the word "calendar" / "в календарь" / "календар", or mentions an event/schedule/appointment/reminder for a specific date (e.g. "add to calendar", "в календарь задачу на завтра"), put it in calendar_events! Support action="add", "edit", or "delete".
   - Tasks: General chores, to-dos, checklists, things to do without asking for the calendar. Support action="add", "complete", "edit", or "delete".
3. Meal Planner (Menu of the Week): If the user talks about the weekly menu, meals (breakfast, lunch, dinner, snack), setting a dish for a day, creating a new dish/recipe, or adding dish ingredients to the shopping list, populate meal_actions!
4. Timer: If user says "set timer for 10 minutes", populate timer object (minutes as number).
5. Notes: Generic info, reminders, thoughts. If user asks to edit or delete a note, return an object in notes with action="edit" or "delete" and match/id.
6. Only return non-empty arrays/objects when detected. If a field is not present, use empty array [] or null for timer.`;

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
  const todayStr = new Date().toISOString().slice(0, 10);
  const systemWithToday = system.replace(/Today is \d{4}-\d{2}-\d{2}\./, `Today is ${todayStr}.`);
  let prompt = `${systemWithToday}\n\nToday's date is ${todayStr}.\n${basePrompt}`;
  if (senderName) {
    prompt += `\nThe sender's name is ${senderName}.`;
  }

  // Inject current family profiles if available
  try {
    const profiles = typeof getProfiles === 'function' ? getProfiles() : [];
    if (profiles && profiles.length > 0) {
      const names = profiles.map(p => `- ${p.name || 'Member'} (ID: ${p.id})`).join('\n');
      prompt += `\n\nRegistered family members:\n${names}\n(Match exact name for assignee/person, or use null/"family" if for the whole family. If the user mentions a person not in this list, mention in response_message that they are not recognized)`;
    }
  } catch (e) {}

  // Inject existing lists (including custom lists!) if available
  try {
    const lists = typeof getLists === 'function' ? getLists() : [];
    if (lists && lists.length > 0) {
      const listNames = lists.map(l => `- ${l.name} (type: ${l.type})`).join('\n');
      prompt += `\n\nExisting dashboard lists (Shopping, Tasks, and Custom Lists):\n${listNames}\n(Select from these existing lists when applicable by setting list_name. You can also target any custom list or create a new custom list if requested.)`;
    }
  } catch (e) {}

  // Inject available calendar feeds if available
  try {
    const feeds = typeof getCalendarFeeds === 'function' ? getCalendarFeeds() : [];
    if (feeds && feeds.length > 0) {
      const feedNames = feeds.map(f => `- ${f.name}${f.profile_name ? ` (assigned to ${f.profile_name})` : ' (Family/General)'}`).join('\n');
      prompt += `\n\nAvailable calendar feeds:\n${feedNames}\n(Select the most relevant calendar or member for events. If none match, note it in response_message)`;
    }
  } catch (e) {}

  // Inject meal slots & dishes for Menu of the Week
  try {
    const slots = typeof getDefaultMealSlots === 'function' ? getDefaultMealSlots() : ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
    const dishes = typeof getDishes === 'function' ? getDishes() : [];
    const dishNames = dishes.slice(0, 40).map(d => d.name).join(', ');
    prompt += `\n\nMeal Planner slots: ${slots.join(', ')}${dishNames ? `\nKnown dishes in catalog: ${dishNames}` : ''}`;
    if (!prompt.includes('meal_actions')) {
      prompt += `\nFor Meal Planner requests, include "meal_actions": [{ "action": "set_meal|add_dish|ingredients_to_shopping", "day": "Monday..Sunday", "slot": "Breakfast|Lunch|Dinner|Snack", "dish_name": "string", "ingredients": ["string"], "recipe": "string", "tags": ["string"] }].`;
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
        recurrence_interval: 1,
        action: 'add'
      };
    }

    const title = String(task.title || task.content || task.name || task.match || '').trim();
    if (!title && !task.id) return null;

    return {
      id: task.id ? Number(task.id) : null,
      title,
      new_title: task.new_title ? String(task.new_title).trim() : null,
      match: task.match ? String(task.match).trim() : null,
      assignee: cleanAssignee(task.assignee),
      reward: Number(task.reward ?? task.points ?? 0) || 0,
      due_date: task.due_date || task.date || null,
      due_time: task.due_time || task.time || null,
      recurrence: task.recurrence || 'none',
      recurrence_interval: Number(task.recurrence_interval || task.interval || 1) || 1,
      recurrence_days: Array.isArray(task.recurrence_days) ? task.recurrence_days : (
        task.recurrence_days ? [task.recurrence_days] : null
      ),
      action: String(task.action || 'add').toLowerCase()
    };
  }).filter(Boolean);

  const rawListItems = [...toArray(parsed.shopping_items), ...toArray(parsed.list_items)];
  const normalizedShoppingItems = rawListItems.map((item) => {
    if (typeof item === 'string') {
      return {
        content: item.trim(),
        assignee: null,
        list_name: null,
        recurrence: 'none',
        recurrence_interval: 1,
        action: 'add'
      };
    }
    const content = String(item.content || item.name || item.title || item.match || '').trim();
    if (!content && !item.id) return null;
    return {
      id: item.id ? Number(item.id) : null,
      content,
      new_content: item.new_content ? String(item.new_content).trim() : null,
      assignee: cleanAssignee(item.assignee),
      list_name: item.list_name ? String(item.list_name).trim() : null,
      recurrence: item.recurrence || 'none',
      recurrence_interval: Number(item.recurrence_interval || 1) || 1,
      action: String(item.action || 'add').toLowerCase()
    };
  }).filter(Boolean);

  const normalizedCalendarEvents = toArray(parsed.calendar_events).map((event) => {
    if (typeof event === 'string') {
      return { title: event.trim(), date: null, time: null, all_day: false, person: null, recurrence: 'none', recurrence_interval: 1, action: 'add' };
    }
    const title = String(event.title || event.name || event.match || '').trim();
    if (!title && !event.id) return null;
    return {
      id: event.id ? Number(event.id) : null,
      title,
      new_title: event.new_title ? String(event.new_title).trim() : null,
      date: event.date || null,
      time: event.time || null,
      all_day: Boolean(event.all_day),
      person: cleanAssignee(event.person || event.assignee),
      recurrence: event.recurrence || 'none',
      recurrence_interval: Number(event.recurrence_interval || 1) || 1,
      action: String(event.action || 'add').toLowerCase()
    };
  }).filter(Boolean);

  const normalizedNotes = toArray(parsed.notes).map((note) => {
    if (typeof note === 'string') {
      const clean = note.trim();
      return clean || null;
    }
    if (note && typeof note === 'object') {
      const action = String(note.action || 'add').toLowerCase();
      const content = String(note.content || note.text || '').trim();
      const match = note.match ? String(note.match).trim() : null;
      const id = note.id ? Number(note.id) : null;
      if (action === 'add' && content) return content;
      return { action, content, match, id };
    }
    return null;
  }).filter(Boolean);

  const normalizedMealActions = toArray(parsed.meal_actions || parsed.meal_plan).map((m) => {
    if (!m || typeof m !== 'object') return null;
    const dishName = String(m.dish_name || m.dish || m.name || '').trim();
    if (!dishName && m.action !== 'ingredients_to_shopping') return null;
    return {
      action: String(m.action || 'set_meal').toLowerCase(),
      day: m.day ? String(m.day).trim() : null,
      slot: m.slot || m.meal_slot ? String(m.slot || m.meal_slot).trim() : 'Dinner',
      dish_name: dishName,
      ingredients: Array.isArray(m.ingredients) ? m.ingredients.map(i => String(i).trim()).filter(Boolean) : [],
      recipe: m.recipe ? String(m.recipe).trim() : '',
      tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : []
    };
  }).filter(Boolean);

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
    meal_actions: normalizedMealActions,
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
