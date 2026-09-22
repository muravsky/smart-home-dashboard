const { GoogleGenerativeAI } = require('@google/generative-ai');

const SYSTEM_PROMPT = `Parse this text and return ONLY raw JSON. Schema: { "notes": ["string"], "tasks": [{ "assignee": "string", "title": "string", "reward": number }] }.`;

/**
 * Parse incoming text from Telegram using Gemini 1.5 Flash.
 * Returns { notes: string[], tasks: Array<{ assignee: string, title: string, reward: number }> }
 */
async function parseTextWithGemini(userText) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('[Gemini] GEMINI_API_KEY is not configured in .env');
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: SYSTEM_PROMPT,
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
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
  };
}

module.exports = {
  SYSTEM_PROMPT,
  parseTextWithGemini
};
