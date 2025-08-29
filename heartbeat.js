// heartbeat.js
import dotenv from "dotenv";
dotenv.config();
import https from "https";
import http from "http";
import crypto from "crypto";
import getSwissTime from "./timeHelper.js";
import logger from "./logger.js";

dotenv.config({ quiet: true });

const QR_IP   = process.env.QR_SCANNER_IP;
const QR_USER = process.env.QR_SCANNER_USER;
const QR_PASS = process.env.QR_SCANNER_PASS;
const SHELLY_IP   = process.env.SHELLY_IP;
const SHELLY_PASS = process.env.SHELLY_PASSWORD;

// ✅ Heartbeat settings in SECONDS (defaults: interval=120s, lostAlarm=5s)
const HEARTBEAT_INTERVAL_SEC = Number(process.env.HEARTBEAT_INTERVAL_SEC ?? 120);
const HEARTBEAT_INTERVAL     = HEARTBEAT_INTERVAL_SEC * 1000;

const LOST_ALARM_SEC = Number(process.env.HEARTBEAT_CONNECTION_LOST_ALARM_SEC ?? 5);
const LOST_ALARM_MS  = LOST_ALARM_SEC * 1000;

const MAX_FAILS = Number(process.env.HEARTBEAT_MAX_FAILS ?? 5);

async function formatSwissNow() {
  const now = await getSwissTime();
  return new Intl.DateTimeFormat("de-CH", {
    timeZone: "Europe/Zurich",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(now);
}

function parseDigest(header) {
  const parts = {};
  (header || "").replace(/([a-z0-9\-]+)="?([^",]+)"?/gi, (_, k, v) => (parts[k] = v));
  return parts;
}

function buildDigestMD5({ realm, nonce, qop }, method, path, user, pass, nc, cnonce) {
  const ha1 = crypto.createHash("md5").update(`${user}:${realm}:${pass}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${path}`).digest("hex");
  const resp = crypto.createHash("md5").update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest("hex");
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${resp}"`;
}

function buildDigestSHA256({ realm, nonce, qop }, method, path, user, pass, nc, cnonce) {
  const ha1 = crypto.createHash("sha256").update(`${user}:${realm}:${pass}`).digest("hex");
  const ha2 = crypto.createHash("sha256").update(`${method}:${path}`).digest("hex");
  const resp = crypto.createHash("sha256").update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest("hex");
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", algorithm=SHA-256, response="${resp}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
}

function runHeartbeat(label, client, opts, digestFn, user, pass) {
  let lastAlive = Date.now();
  let failCount = 0;
  let alarmTriggered = false;

  async function markAlive() {
    const ts = await formatSwissNow();
    if (failCount >= MAX_FAILS && alarmTriggered) {
      logger.info(`✅ ${label} is back online [${ts}] (send notification)`);
    } else {
      logger.info(`💓 ${label} alive [${ts}]`);
    }
    failCount = 0;
    alarmTriggered = false;
    lastAlive = Date.now();
  }

  function markFail(reason) {
    failCount++;
    logger.warn(`⚠️ ${label} check failed (${failCount}) - ${reason}`);

    if (failCount >= MAX_FAILS && !alarmTriggered) {
      logger.error(`🔥 FIREALARM ${label} still offline after ${failCount} tries (send notification)`);
      alarmTriggered = true;
    }

    if (Date.now() - lastAlive > LOST_ALARM_MS) {
      logger.warn(`🚨 ${label} LOST CONNECTION > ${LOST_ALARM_SEC}s`);
    }
  }

  function checkDevice() {
    return new Promise((resolve) => {
      const req1 = client.request(opts, async (res1) => {
        if (res1.statusCode === 200) {
          await markAlive();
          res1.resume(); return resolve();
        }
        if (res1.statusCode === 401) {
          const chal = parseDigest(res1.headers["www-authenticate"]);
          const nc = "00000001";
          const cnonce = crypto.randomBytes(8).toString("hex");
          const auth = digestFn(chal, "GET", opts.path, user, pass, nc, cnonce);
          const req2 = client.request({ ...opts, headers: { Authorization: auth } }, async (res2) => {
            if (res2.statusCode === 200) {
              await markAlive();
            } else {
              markFail(`auth failed ${res2.statusCode}`);
            }
            res2.resume(); resolve();
          });
          req2.on("error", (e) => { markFail(e.message); resolve(); });
          req2.on("timeout", () => { req2.destroy(); markFail("timeout req2"); resolve(); });
          req2.end();
          return;
        }
        markFail(`unexpected status ${res1.statusCode}`);
        res1.resume(); resolve();
      });
      req1.on("error", (e) => { markFail(e.message); resolve(); });
      req1.on("timeout", () => { req1.destroy(); markFail("timeout req1"); resolve(); });
      req1.end();
    });
  }

  logger.info(`[INFO] Heartbeat started for ${label} (interval ${HEARTBEAT_INTERVAL_SEC}s)`);

  checkDevice();
  setInterval(checkDevice, HEARTBEAT_INTERVAL);
}

// -------- export main ----------
export function startHeartbeat() {
  logger.info("[INFO] Starting all heartbeats");

  // QR-Scanner: use 10s timeout
  runHeartbeat(
    "QR-Scanner",
    https,
    { host: QR_IP, port: 443, path: "/ISAPI/System/deviceInfo", method: "GET", rejectUnauthorized: false, timeout: 10000 },
    buildDigestMD5,
    QR_USER,
    QR_PASS
  );

  // Shelly: use 3s timeout
  runHeartbeat(
    "Shelly",
    http,
    { host: SHELLY_IP, port: 80, path: "/rpc/Shelly.GetStatus", method: "GET", timeout: 3000 },
    buildDigestSHA256,
    "admin",
    SHELLY_PASS
  );
}
