// notify.js
const lastSent = new Map(); // message -> timestamp
const THROTTLE_MS = 30 * 60 * 1000; // 30 minutes

export function sendNotification(level, message) {
  try {
    const now = Date.now();
    const key = `${level}:${message}`;

    if (lastSent.has(key) && now - lastSent.get(key) < THROTTLE_MS) {
      return; // throttled
    }

    lastSent.set(key, now);
    console.log(`[NOTIFY] (${level.toUpperCase()}) ${message}`);
  } catch (err) {
    console.error("Notify error:", err.message);
  }
}
