const { GoogleGenerativeAI } = require('@google/generative-ai');

function buildSystemPrompt() {
  const todayStr = new Date().toISOString().slice(0, 10);
  return `You are the smart assistant for a family smart home tablet dashboard. Today is ${todayStr}.
Analyze the user's natural language input and return ONLY raw JSON matching this schema:
{
  "notes": ["string of note content"],
  "tasks": [
    {
      "title": "string",
      "assignee": "string or null",
      "reward": 0,
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
      "time": "HH:MM",
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
4. Tasks: Chores, to-dos, things to do. If reward is mentioned (e.g. "for 15 points"), set reward number.
5. Notes: Generic info, reminders, thoughts.
6. Only return non-empty arrays/objects when detected. If a field is not present, use empty array [] or null for timer.`;
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
  const prompt = buildSystemPrompt() + (senderName ? `\nThe sender's name is ${senderName}.` : '');

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

  return {
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    shopping_items: Array.isArray(parsed.shopping_items) ? parsed.shopping_items : [],
    calendar_events: Array.isArray(parsed.calendar_events) ? parsed.calendar_events : [],
    timer: parsed.timer && typeof parsed.timer === 'object' ? parsed.timer : null,
    response_message: parsed.response_message || ''
  };
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
  const prompt = buildSystemPrompt() + (senderName ? `\nThe sender's name is ${senderName}.` : '');

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
    'Please listen carefully to this voice recording, transcribe it, and extract the smart home actions according to the schema.'
  ]);

  let rawContent = response.response.text().trim();
  rawContent = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const parsed = JSON.parse(rawContent);

  return {
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    shopping_items: Array.isArray(parsed.shopping_items) ? parsed.shopping_items : [],
    calendar_events: Array.isArray(parsed.calendar_events) ? parsed.calendar_events : [],
    timer: parsed.timer && typeof parsed.timer === 'object' ? parsed.timer : null,
    response_message: parsed.response_message || ''
  };
}

module.exports = {
  buildSystemPrompt,
  parseTextWithGemini,
  parseAudioWithGemini
};
