// shellyAllOff.js
// Shelly Pro 3 — turn ALL 3 outputs OFF.
// - Non-blocking: exported function schedules work with setImmediate()
// - Robust: digest auth, timeouts, retries, never throws to caller
// - Production: uses logger, handles errors gracefully, app keeps running

import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import crypto from "crypto";
import logger from "./logger.js";

// ==== ENV ====
const SHELLY_IP    = process.env.SHELLY_IP;
const SHELLY_USER  = process.env.SHELLY_USER || "admin";
const SHELLY_PASS  = process.env.SHELLY_PASSWORD;
const SHELLY_PORT  = Number(process.env.SHELLY_PORT || 80);
const SHELLY_PROTO = process.env.SHELLY_PROTO || "http";

// Always target 3 channels (0,1,2). Optional override via SHELLY_OFF_CHANNELS="0,1,2"
const CHANNELS = (process.env.SHELLY_OFF_CHANNELS || "0,1,2")
  .split(",").map(s => Number(s.trim())).filter(Number.isFinite);

// Tunables
const TIMEOUT_MS   = 6000;
const MAX_TRIES    = 3;
const BASE_BACKOFF = 250; // ms

// ==== Digest helpers ====
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function parseDigest(header) {
  const out = {};
  (header || "").replace(/(\w+)=(?:"([^"]+)"|([^\s,]+))/g, (_m, k, v1, v2) => { out[k] = v1 ?? v2; });
  return out;
}
function buildDigest(method, uri, user, pass, chalHdr) {
  const c = parseDigest(chalHdr || "");
  const realm = c.realm || "";
  const nonce = c.nonce || "";
  const qop   = (c.qop || "").split(",").map(s => s.trim()).find(v => v === "auth");
  const opaque = c.opaque;

  const baseHA1 = sha256(`${user}:${realm}:${pass}`);
  const cnonce  = crypto.randomBytes(8).toString("hex");
  const ha2     = sha256(`${method}:${uri}`);
  const nc      = "00000001";
  const resp    = qop
    ? sha256(`${baseHA1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : sha256(`${baseHA1}:${nonce}:${ha2}`);

  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=SHA-256${
    qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : ""
  }, response="${resp}"${opaque ? `, opaque="${opaque}"` : ""}`;
}

// ==== HTTP (safe) ====
async function rpcPostSafe(method, params) {
  const path = `/rpc/${method}`;
  const url  = `${SHELLY_PROTO}://${SHELLY_IP}:${SHELLY_PORT}${path}`;
  const body = JSON.stringify(params);

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
    if (r.status === 401) {
      const auth = buildDigest("POST", path, SHELLY_USER, SHELLY_PASS, r.headers.get("www-authenticate"));
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body, signal: controller.signal });
    }
    const txt = await r.text();
    if (!r.ok) {
      return { ok: false, status: r.status, text: txt };
    }
    try {
      const j = JSON.parse(txt);
      return { ok: true, result: j.result ?? j.params ?? j };
    } catch {
      return { ok: true, result: {} };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(to);
  }
}

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const res = await fn();
    if (res?.ok) return true;
    const msg = res?.error || res?.text || `HTTP ${res?.status ?? "?"}`;
    if (attempt < MAX_TRIES) {
      const backoff = BASE_BACKOFF * Math.pow(2, attempt - 1);
      logger.warn(`${label} failed (try ${attempt}/${MAX_TRIES}): ${msg}; retrying in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    } else {
      logger.error(`${label} failed after ${MAX_TRIES} attempts: ${msg}`);
      return false;
    }
  }
  return false;
}

// ==== Device op ====
async function switchOff(id) {
  return withRetry(
    () => rpcPostSafe("Switch.Set", { id, on: false }),
    `Switch.Set OFF ch${id}`
  );
}

// ==== Exported non-blocking entry ====
export function setAllShellyOutputsOff() {
  setImmediate(async () => {
    try {
      if (!SHELLY_IP || !SHELLY_PASS) {
        logger.error("setAllShellyOutputsOff: missing SHELLY_IP or SHELLY_PASSWORD in .env");
        return;
      }
      if (!CHANNELS.length) {
        logger.warn("setAllShellyOutputsOff: no channels configured");
        return;
      }

      const results = await Promise.allSettled(
        CHANNELS.map(async (id) => {
          const ok = await switchOff(id);
          if (ok) logger.info(`Shelly channel ${id} set to OFF`);
        })
      );

      // summarize
      const rejected = results.filter(r => r.status === "rejected");
      if (rejected.length) {
        logger.warn(`setAllShellyOutputsOff finished with ${rejected.length} error(s).`);
      } else {
        logger.info("setAllShellyOutputsOff finished.");
      }
    } catch (err) {
      // Never crash the app
      logger.error(`setAllShellyOutputsOff fatal: ${err?.stack || err?.message || String(err)}`);
    }
  });
}
