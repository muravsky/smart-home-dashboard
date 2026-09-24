/**
 * Weather service using Open-Meteo free API (no API key required).
 */
const { getSettings } = require('../db');

let cachedWeather = null;
let lastFetchTime = 0;
let lastSettingsHash = '';
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

function clearWeatherCache() {
  cachedWeather = null;
  lastFetchTime = 0;
}

async function searchCity(query) {
  if (!query || query.trim().length < 2) return [];
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=5&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.results) return [];
    return data.results.map(r => ({
      name: r.name,
      country: r.country || '',
      admin1: r.admin1 || '',
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone || 'auto'
    }));
  } catch (err) {
    console.warn('[Weather Service] City search failed:', err.message);
    return [];
  }
}

async function getWeather() {
  const now = Date.now();
  let settings = {};
  try {
    settings = getSettings();
  } catch(e) {}

  const lat = settings.weather_lat || process.env.WEATHER_LAT || '52.5200';
  const lon = settings.weather_lon || process.env.WEATHER_LON || '13.4050';
  const city = settings.weather_city || 'Berlin';
  const units = settings.weather_units || 'metric'; // 'metric' or 'imperial'

  const currentSettingsHash = `${lat}_${lon}_${units}`;
  if (cachedWeather && currentSettingsHash === lastSettingsHash && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedWeather;
  }

  try {
    const tempUnitParam = units === 'imperial' ? '&temperature_unit=fahrenheit' : '';
    const windUnitParam = units === 'imperial' ? '&wind_speed_unit=mph' : '';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&hourly=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=10&timezone=auto${tempUnitParam}${windUnitParam}`;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

    const data = await res.json();
    const current = data.current || {};
    const code = current.weather_code || 0;
    const wmo = WMO_CODES[code] || { label: 'Clear', icon: '☀️' };

    const daily = data.daily || {};
    const tempMax = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null;
    const tempMin = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null;

    const hourlyForecast = (data.hourly && Array.isArray(data.hourly.time) ? data.hourly.time : []).map((time, idx) => {
      const hourCode = Number(data.hourly.weather_code?.[idx] ?? 0);
      const iconData = WMO_CODES[hourCode] || { label: 'Clear Sky', icon: '☀️' };
      const tempVal = Number(data.hourly.temperature_2m?.[idx]);
      const feelsVal = Number(data.hourly.apparent_temperature?.[idx] ?? tempVal ?? 0);
      const precipVal = Number(data.hourly.precipitation?.[idx] ?? 0);
      const windVal = Number(data.hourly.wind_speed_10m?.[idx] ?? 0);
      return {
        time,
        label: new Date(time).toLocaleTimeString([], { hour: 'numeric' }),
        temperature: Number.isFinite(tempVal) ? Math.round(tempVal) : 0,
        feelsLike: Number.isFinite(feelsVal) ? Math.round(feelsVal) : 0,
        precipitation: Number.isFinite(precipVal) ? precipVal : 0,
        windSpeed: Number.isFinite(windVal) ? Math.round(windVal) : 0,
        condition: iconData.label,
        icon: iconData.icon
      };
    }).slice(0, 12);

    const dailyForecast = (data.daily && Array.isArray(data.daily.time) ? data.daily.time : []).map((date, idx) => {
      const dailyCode = Number(data.daily.weather_code?.[idx] ?? 0);
      const dayWmo = WMO_CODES[dailyCode] || { label: 'Clear Sky', icon: '☀️' };
      const max = Number(data.daily.temperature_2m_max?.[idx]);
      const min = Number(data.daily.temperature_2m_min?.[idx]);
      const precip = Number(data.daily.precipitation_sum?.[idx] ?? 0);
      return {
        date,
        label: new Date(date).toLocaleDateString([], { weekday: 'short' }),
        temperature: Number.isFinite(max) ? Math.round(max) : 0,
        tempMin: Number.isFinite(min) ? Math.round(min) : 0,
        precipitation: Number.isFinite(precip) ? precip : 0,
        condition: dayWmo.label,
        icon: dayWmo.icon
      };
    }).slice(0, 10);

    cachedWeather = {
      city,
      latitude: lat,
      longitude: lon,
      units,
      unit: units === 'imperial' ? 'F' : 'C',
      temperature: Math.round(current.temperature_2m),
      feelsLike: Math.round(current.apparent_temperature),
      humidity: current.relative_humidity_2m,
      precipitation: Number(current.precipitation || 0),
      windSpeed: Math.round(current.wind_speed_10m),
      condition: wmo.label,
      icon: wmo.icon,
      tempMax,
      tempMin,
      forecast: {
        hourly: hourlyForecast,
        daily: dailyForecast
      },
      updatedAt: new Date().toISOString()
    };
    lastFetchTime = now;
    lastSettingsHash = currentSettingsHash;
    return cachedWeather;
  } catch (err) {
    console.warn('[Weather Service] Failed to fetch weather:', err.message);
    if (cachedWeather) return cachedWeather;
    return {
      city,
      latitude: lat,
      longitude: lon,
      units,
      unit: units === 'imperial' ? 'F' : 'C',
      temperature: units === 'imperial' ? 70 : 21,
      feelsLike: units === 'imperial' ? 68 : 20,
      humidity: 45,
      precipitation: 0,
      windSpeed: units === 'imperial' ? 6 : 10,
      condition: 'Clear Sky',
      icon: '☀️',
      tempMax: units === 'imperial' ? 75 : 24,
      tempMin: units === 'imperial' ? 60 : 16,
      forecast: {
        hourly: Array.from({ length: 12 }, (_, idx) => ({
          time: `fallback-${idx}`,
          label: `${idx + 1}h`,
          temperature: units === 'imperial' ? 70 : 21,
          precipitation: 0,
          icon: '☀️'
        })),
        daily: Array.from({ length: 7 }, (_, idx) => ({
          date: `fallback-${idx}`,
          label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][idx % 7],
          temperature: units === 'imperial' ? 72 : 22,
          tempMin: units === 'imperial' ? 60 : 16,
          precipitation: 0,
          icon: '☀️'
        }))
      },
      updatedAt: new Date().toISOString(),
      fallback: true
    };
  }
}

module.exports = { getWeather, searchCity, clearWeatherCache };
