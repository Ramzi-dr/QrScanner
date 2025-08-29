// dstAuto.js
// Auto-set DST by switching timeZone between CST-1:00:00 (winter) and CST-2:00:00 (summer)
// Region rule: Europe (last Sunday of March 02:00 → last Sunday of Oct 03:00)
// Robust: if device unreachable, retry every 15 minutes until success; stop after success.
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import crypto from "crypto";
import logger from "./logger.js";
import getSwissTime from "./timeHelper.js";

const IP   = process.env.QR_SCANNER_IP;   // e.g. 192.168.10.58
const USER = process.env.QR_SCANNER_USER; // e.g. admin
const PASS = process.env.QR_SCANNER_PASS;

const RETRY_MS = 15 * 60 * 1000;          // 15 minutes
const FETCH_TIMEOUT_MS = 5000;            // 5s to fail fast on dead hosts

// ---- internal state to avoid duplicate concurrent loops ----
let retryTimer = null;
let running = false;

// ---- helpers ----
function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

function parseDigest(h) {
  const out = {};
  for (const m of (h || "").matchAll(/(\w+)="?([^",]+)"?/g)) out[m[1]] = m[2];
  return out;
}

function lastSunday(year, month /*1-12*/) {
  const d = new Date(Date.UTC(year, month, 1, 0, 0, 0)); // first day of next month
  d.setUTCDate(0); // last day of target month
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to Sunday
  return d; // 00:00 UTC of that Sunday
}

// Europe DST window (local): from Mar last Sunday 02:00 to Oct last Sunday 03:00
function isEuropeSummerNow(now = new Date()) {
  const y = now.getUTCFullYear();
  const start = lastSunday(y, 3);  // Mar
  const end   = lastSunday(y, 10); // Oct
  const startUTC = new Date(Date.UTC(y, start.getUTCMonth(), start.getUTCDate(), 2, 0, 0));
  const endUTC   = new Date(Date.UTC(y, end.getUTCMonth(),   end.getUTCDate(),   3, 0, 0));
  return now >= startUTC && now < endUTC;
}

async function fetchWithTimeout(url, opts = {}) {
  const { timeout = FETCH_TIMEOUT_MS, ...rest } = opts;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { signal: ctrl.signal, ...rest });
  } finally {
    clearTimeout(id);
  }
}

async function putTimeZone(zone) {
  const uri = "/ISAPI/System/time";
  const url = `http://${IP}${uri}`;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<Time>
  <timeMode>NTP</timeMode>
  <timeZone>${zone}</timeZone>
</Time>`;

  try {
    // 1) challenge
    const r1 = await fetchWithTimeout(url, {
      method: "PUT",
      body,
      headers: { "Content-Type": "application/xml" },
    });
    const wa = r1.headers.get("www-authenticate");

    if (r1.status !== 401 || !wa) {
      if (r1.status === 200) return true;
      logger.error(`Unexpected response (no digest challenge): HTTP ${r1.status}`);
      return false;
    }

    // 2) digest auth
    const chal = parseDigest(wa);
    const ha1 = md5(`${USER}:${chal.realm}:${PASS}`);
    const ha2 = md5(`PUT:${uri}`);
    const resp = md5(`${ha1}:${chal.nonce}:${ha2}`);
    const auth = `Digest username="${USER}", realm="${chal.realm}", nonce="${chal.nonce}", uri="${uri}", response="${resp}", algorithm="MD5"`;

    // 3) authenticated PUT
    const r2 = await fetchWithTimeout(url, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/xml" },
      body,
    });

    if (r2.status === 200) return true;

    logger.error(`Failed to set timeZone ${zone}: HTTP ${r2.status}`);
    return false;
  } catch (err) {
    // Typical offline errors: EHOSTUNREACH, ETIMEDOUT, ECONNREFUSED, AbortError
    const msg = err && (err.code || err.name) ? `${err.code || err.name}: ${err.message}` : (err?.message || String(err));
    logger.notify?.("ERROR", `putTimeZone failed for ${zone}: ${msg}`); // if notify wrapper exists
    logger.error(`putTimeZone failed for ${zone}: ${msg}`);
    return false;
  }
}

function scheduleRetry() {
  if (retryTimer) return; // already scheduled
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      await attemptUpdateDST();
    } catch (e) {
      logger.error(`Retry attempt crashed: ${e?.message || e}`);
      // schedule next retry again if something unexpected exploded
      scheduleRetry();
    }
  }, RETRY_MS);
  logger.warn(`Device unreachable. Will retry DST update in ${Math.round(RETRY_MS / 60000)} minutes.`);
}

async function attemptUpdateDST() {
  if (!IP || !USER || !PASS) {
    logger.error("Missing QR_SCANNER_IP/USER/PASS in .env");
    return;
  }

  if (running) {
    // Avoid overlapping attempts from multiple callers
    logger.warn("updateDST already running; skipping concurrent call.");
    return;
  }

  running = true;
  try {
    const now = await getSwissTime(); // Swiss local time
    const summer = isEuropeSummerNow(now);
    const zone = summer ? "CST-2:00:00" : "CST-1:00:00";

    const ok = await putTimeZone(zone);
    if (ok) {
      logger.warn(`Time zone updated to ${zone}. Stopping retries.`);
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      return;
    }

    // schedule next retry
    scheduleRetry();
  } catch (err) {
    logger.error(`updateDST attempt failed: ${err?.message || err}`);
    scheduleRetry();
  } finally {
    running = false;
  }
}

// ---- exported: non-blocking for callers ----
export function updateDST() {
  // Fire-and-forget; handles its own retries
  attemptUpdateDST().catch((e) => {
    logger.error(`updateDST launch error: ${e?.message || e}`);
    scheduleRetry();
  });
}
