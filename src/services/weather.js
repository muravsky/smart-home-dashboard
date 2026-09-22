/**
 * Weather service using Open-Meteo free API (no API key required).
 */

let cachedWeather = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const WMO_CODES = {
  0: { label: 'Clear Sky', icon: '☀️' },
  1: { label: 'Mainly Clear', icon: '🌤️' },
  2: { label: 'Partly Cloudy', icon: '⛅' },
  3: { label: 'Overcast', icon: '☁️' },
  45: { label: 'Foggy', icon: '🌫️' },
  48: { label: 'Depositing Rime Fog', icon: '🌫️' },
  51: { label: 'Light Drizzle', icon: '🌦️' },
  53: { label: 'Moderate Drizzle', icon: '🌦️' },
  55: { label: 'Dense Drizzle', icon: '🌧️' },
  61: { label: 'Slight Rain', icon: '🌧️' },
  63: { label: 'Moderate Rain', icon: '🌧️' },
  65: { label: 'Heavy Rain', icon: '🌧️' },
  71: { label: 'Slight Snow', icon: '🌨️' },
  73: { label: 'Moderate Snow', icon: '🌨️' },
  75: { label: 'Heavy Snow', icon: '❄️' },
  80: { label: 'Rain Showers', icon: '🌦️' },
  81: { label: 'Moderate Showers', icon: '🌧️' },
  82: { label: 'Violent Showers', icon: '⛈️' },
  95: { label: 'Thunderstorm', icon: '⚡' },
  96: { label: 'Thunderstorm with Hail', icon: '⛈️' }
};

async function getWeather() {
  const now = Date.now();
  if (cachedWeather && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedWeather;
  }

  const lat = process.env.WEATHER_LAT || '52.5200';
  const lon = process.env.WEATHER_LON || '13.4050';

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

    const data = await res.json();
    const current = data.current || {};
    const code = current.weather_code || 0;
    const wmo = WMO_CODES[code] || { label: 'Clear', icon: '☀️' };

    const daily = data.daily || {};
    const tempMax = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null;
    const tempMin = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null;

    cachedWeather = {
      temperature: Math.round(current.temperature_2m),
      humidity: current.relative_humidity_2m,
      windSpeed: Math.round(current.wind_speed_10m),
      condition: wmo.label,
      icon: wmo.icon,
      tempMax,
      tempMin,
      updatedAt: new Date().toISOString()
    };
    lastFetchTime = now;
    return cachedWeather;
  } catch (err) {
    console.warn('[Weather Service] Failed to fetch weather:', err.message);
    if (cachedWeather) return cachedWeather;
    return {
      temperature: 21,
      humidity: 45,
      windSpeed: 10,
      condition: 'Clear Sky',
      icon: '☀️',
      tempMax: 24,
      tempMin: 16,
      updatedAt: new Date().toISOString(),
      fallback: true
    };
  }
}

module.exports = { getWeather };
