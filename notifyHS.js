// notifyHS.js
import 'dotenv/config';

// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // for self-signed HTTPS

const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const RECEIVER_EMAIL = (process.env.NOTIFICATION_RECEIVER_EMAIL || '').trim().toLowerCase();
const TITLE = process.env.NOTIFICATION_TITLE || '';
const NOTIFY_LOGIN_URL = process.env.NOTIFY_LOGIN_URL || 'http://hs_notifier:4000/login';
const NOTIFY_URL = process.env.NOTIFY_ENDPOINT_URL || 'http://hs_notifier:4000/notifier';

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY = 2000; // ms

let firstTimeCalled = true;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    let data = {};
    try { data = await resp.json(); } catch { /* ignore non-JSON */ }
    return { resp, data };
  } catch {
    throw new Error('fetch failed');
  } finally {
    clearTimeout(t);
  }
}

async function runNotify(message, email = null) {
  try {
    if (firstTimeCalled) {
      await sleep(2000);
      firstTimeCalled = false;
    }

    const receiver = (email || RECEIVER_EMAIL || '').trim().toLowerCase();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Login
        const { resp: loginResp, data: loginData } = await fetchJSON(NOTIFY_LOGIN_URL, {
          method: 'POST',
          body: { username: AUTH_USER, password: AUTH_PASS },
          timeoutMs: 10000,
        });
        if (loginResp.status !== 200) throw new Error('login http');
        const token = loginData?.token;
        if (!token) throw new Error('no token');

        // Notify
        const { resp: notifyResp } = await fetchJSON(NOTIFY_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: { receiver, title: TITLE, message },
          timeoutMs: 10000,
        });
        if (notifyResp.status !== 200) throw new Error('notify http');

        return; // success
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_DELAY * attempt);
        } else {
          return; // give up silently
        }
      }
    }
  } catch {
    return; // never crash caller
  }
}

/**
 * Fire-and-forget: returns immediately, runs in background.
 */
export function notifyHS(message, email = null) {
  // schedule without blocking the caller
  setTimeout(() => { void runNotify(message, email); }, 0);
}
