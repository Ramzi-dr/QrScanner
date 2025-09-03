import 'dotenv/config';
import logger from './logger.js';

// detect if running inside Docker
function inDocker() {
  try {
    return Boolean(process.env.DOCKER) || require('fs').existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

// ---- Config ----
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const DEFAULT_RECEIVER = normalizeEmail(process.env.NOTIFICATION_RECEIVER_EMAIL || '');
const TITLE = process.env.NOTIFICATION_TITLE || '';

// choose base URL depending on environment
let baseUrl;
if (process.env.NOTIFY_LOGIN_URL && process.env.NOTIFY_ENDPOINT_URL) {
  baseUrl = null; // explicit override from .env
} else if (inDocker()) {
  // Docker-to-Docker: use service name (must match docker-compose service)
  baseUrl = 'http://hs_notifier:4000';
} else {
  // Local host: default to localhost
  baseUrl = 'http://127.0.0.1:4000';
}

const NOTIFY_LOGIN_URL =
  process.env.NOTIFY_LOGIN_URL || `${baseUrl}/login`;
const NOTIFY_URL =
  process.env.NOTIFY_ENDPOINT_URL || `${baseUrl}/notifier`;

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 1500;
const REQ_TIMEOUT_MS = 10_000;

let firstTimeCalled = true;

// ---- Helpers ----
function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function safeJson(resp) {
  try {
    const txt = await resp.text();
    return txt ? JSON.parse(txt) : null;
  } catch {
    return null;
  }
}

async function fetchJSON(url, { method = 'GET', headers = {}, body, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      keepalive: true,
    });
    const data = await safeJson(resp);
    return { resp, data };
  } catch (e) {
    const c = e?.cause || {};
    const details = [
      `name=${e?.name || 'UnknownError'}`,
      `message=${e?.message || 'no-message'}`,
      c.code ? `code=${c.code}` : null,
      c.errno ? `errno=${c.errno}` : null,
      c.address ? `address=${c.address}` : null,
      c.port ? `port=${c.port}` : null,
      `url=${url}`,
      `timeoutMs=${timeoutMs}`
    ].filter(Boolean).join(' | ');
    logger.warn(`[notifyHS] fetchJSON error: ${details}`);
    throw new Error(`fetch failed: ${details}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Core ----
async function runNotify(message, email = null) {
  try {
    const msg = typeof message === 'string' ? message : String(message ?? '');
    const receiver = normalizeEmail(email) || DEFAULT_RECEIVER;

    if (!validateInputs(msg, receiver)) return;

    if (firstTimeCalled) {
      await sleep(1000);
      firstTimeCalled = false;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.warn(`[notifyHS] Attempt ${attempt}/${MAX_RETRIES}: logging in…`);
        const { resp: loginResp, data: loginData } = await fetchJSON(NOTIFY_LOGIN_URL, {
          method: 'POST',
          body: { username: AUTH_USER, password: AUTH_PASS },
        });
        if (!loginResp?.ok) throw new Error(`login http ${loginResp?.status || 'no-status'}`);
        const token = loginData?.token;
        if (!token) throw new Error('no token returned');

        logger.warn('[notifyHS] Login OK. Sending notification…');
        const { resp: notifyResp, data: notifyData } = await fetchJSON(NOTIFY_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: { receiver, title: TITLE, message: msg },
        });
        if (!notifyResp?.ok) {
          const reason = notifyData?.message || 'no body';
          throw new Error(`notify http ${notifyResp.status} (${reason})`);
        }

        logger.warn('[notifyHS] Notification sent successfully.');
        return; // success
      } catch (err) {
        logger.warn(`[notifyHS] Attempt ${attempt}/${MAX_RETRIES} failed: ${err?.message || err}`);
        if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_DELAY * attempt);
      }
    }

    logger.warn('[notifyHS] Gave up after max attempts.');
  } catch (fatal) {
    logger.warn(`[notifyHS] Fatal guard: ${fatal?.message || fatal}`);
  }
}

function validateInputs(msg, receiver) {
  if (!msg || typeof msg !== 'string') {
    logger.warn('[notifyHS] Invalid message (must be non-empty string).');
    return false;
  }
  if (!AUTH_USER || !AUTH_PASS) {
    logger.warn('[notifyHS] Missing AUTH_USER or AUTH_PASS; skipping notify.');
    return false;
  }
  if (!TITLE) {
    logger.warn('[notifyHS] Missing NOTIFICATION_TITLE; skipping notify.');
    return false;
  }
  if (!receiver) {
    logger.warn('[notifyHS] No receiver email; set NOTIFICATION_RECEIVER_EMAIL or pass an email.');
    return false;
  }
  if (!NOTIFY_LOGIN_URL || !NOTIFY_URL) {
    logger.warn('[notifyHS] Missing NOTIFY_* URLs; skipping notify.');
    return false;
  }
  return true;
}

/**
 * Fire-and-forget: returns immediately, runs in background. Never throws.
 */
export function notifyHS(message, email = null) {
  try {
    const safeEmail = normalizeEmail(email);
    setTimeout(() => { void runNotify(message, safeEmail); }, 0);
  } catch (e) {
    logger.warn(`[notifyHS] schedule error: ${e?.message || e}`);
  }
}

export default notifyHS;
