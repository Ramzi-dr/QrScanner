// configureShelly.js
// Create/Upload/Enable/Start Shelly script "HALLO" with dynamic callback:
// WEBHOOK_URL = http://<THIS_SERVER_IP>:<SERVER_PORT><SHELLY_CALLBACK_PATH>
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import crypto from "crypto";
import os from "os";
import logger from "./logger.js";

const SHELLY_IP    = process.env.SHELLY_IP;                  // e.g. 192.168.76.176
const SHELLY_USER  = process.env.SHELLY_USER || "admin";
const SHELLY_PASS  = process.env.SHELLY_PASSWORD;            // e.g. 1948-Spaeter
const SHELLY_PORT  = Number(process.env.SHELLY_PORT || 80);
const SHELLY_PROTO = process.env.SHELLY_PROTO || "http";     // http|https

const SERVER_PORT  = Number(process.env.SERVER_PORT || 3000);
const CALLBACK_PATH = process.env.SHELLY_CALLBACK_PATH || "/shelly";
const CALLBACK_PROTO = process.env.SERVER_PROTO || "http";   // for your app URL

const SCRIPT_NAME  = process.env.SHELLY_SCRIPT_NAME || "Express Server";
const CHUNK_BYTES  = 900;
const TIMEOUT_MS   = 8000;

// ---------- utils ----------
function getLocalIp() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface && iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
  } catch (e) { /* ignore */ }
  return "127.0.0.1";
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const parseDigest = (h) => {
  const out = {}; (h||"").replace(/(\w+)=(?:"([^"]+)"|([^\s,]+))/g, (_,$1,$2,$3)=>out[$1]=$2??$3); return out;
};
function buildDigest(method, uri, user, pass, chalHdr) {
  const c = parseDigest(chalHdr||"");
  const realm=c.realm||"", nonce=c.nonce||"", qop=(c.qop||"").split(",").map(s=>s.trim()).find(v=>v==="auth");
  const opaque=c.opaque;
  const baseHA1 = sha256(`${user}:${realm}:${pass}`);
  const cnonce  = crypto.randomBytes(8).toString("hex");
  const alg = (c.algorithm||"SHA-256").toUpperCase();
  const ha1 = alg.includes("SESS") ? sha256(`${baseHA1}:${nonce}:${cnonce}`) : baseHA1;
  const ha2 = sha256(`${method}:${uri}`);
  const nc  = "00000001";
  const resp = qop ? sha256(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : sha256(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=SHA-256${qop?`, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`:""}, response="${resp}"${opaque?`, opaque="${opaque}"`:""}`;
}
function splitUtf8Bytes(s, max) {
  const b = Buffer.from(s, "utf8"), arr=[];
  for (let i=0;i<b.length;i+=max) arr.push(b.slice(i,i+max).toString("utf8"));
  return arr;
}
async function fetchWithDigestGET(path) {
  const url = `${SHELLY_PROTO}://${SHELLLY_IP_FALLBACK()}:${SHELLLY_PORT_FALLBACK()}${path}`;
  let r = await fetch(url, { method: "GET" });
  if (r.status === 401) {
    const auth = buildDigest("GET", path, SHELLY_USER, SHELLY_PASS, r.headers.get("www-authenticate"));
    r = await fetch(url, { method: "GET", headers: { Authorization: auth } });
  }
  return r;
}
function SHELLLY_IP_FALLBACK(){ return SHELLY_IP; }
function SHELLLY_PORT_FALLBACK(){ return SHELLY_PORT; }

// ---------- RPC helpers ----------
async function rpcPOST(method, params = {}) {
  const path = `/rpc/${method}`;
  const url  = `${SHELLY_PROTO}://${SHELLLY_IP_FALLBACK()}:${SHELLLY_PORT_FALLBACK()}${path}`;
  const body = JSON.stringify({ id: 1, method, params });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
    if (r.status === 401) {
      const auth = buildDigest("POST", path, SHELLY_USER, SHELLY_PASS, r.headers.get("www-authenticate"));
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body, signal: controller.signal });
    }
    const txt = await r.text();
    if (!r.ok) throw new Error(`${method} HTTP ${r.status}: ${txt}`);
    try { const j = JSON.parse(txt); return j.result ?? j.params ?? j; } catch { return {}; }
  } finally { clearTimeout(t); }
}

async function rpcGET(method, paramsObj = {}) {
  // strings MUST be quoted for Shelly RPC over GET
  const qs = Object.entries(paramsObj).map(([k,v]) => {
    if (typeof v === "string") return `${k}=${encodeURIComponent(`"${v}"`)}`;
    if (typeof v === "boolean" || typeof v === "number") return `${k}=${String(v)}`;
    if (v && typeof v === "object") return `${k}=${encodeURIComponent(JSON.stringify(v))}`;
    return `${k}=${encodeURIComponent(String(v))}`;
  }).join("&");

  const path = `/rpc/${method}${qs ? `?${qs}` : ""}`;
  const url  = `${SHELLY_PROTO}://${SHELLLY_IP_FALLBACK()}:${SHELLLY_PORT_FALLBACK()}${path}`;

  let r = await fetch(url, { method: "GET" });
  if (r.status === 401) {
    const auth = buildDigest("GET", path, SHELLY_USER, SHELLY_PASS, r.headers.get("www-authenticate"));
    r = await fetch(url, { method: "GET", headers: { Authorization: auth } });
  }
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}: ${txt}`);
  try { const j = JSON.parse(txt); return j.result ?? j.params ?? j; } catch { return {}; }
}

async function putCodeGET(id, chunk, append) {
  const qs = `id=${id}&code=${encodeURIComponent(`"${chunk}"`)}&append=${append ? "true" : "false"}`;
  const path = `/rpc/Script.PutCode?${qs}`;
  const url  = `${SHELLY_PROTO}://${SHELLLY_IP_FALLBACK()}:${SHELLLY_PORT_FALLBACK()}${path}`;

  let r = await fetch(url, { method: "GET" });
  if (r.status === 401) {
    const auth = buildDigest("GET", path, SHELLY_USER, SHELLY_PASS, r.headers.get("www-authenticate"));
    r = await fetch(url, { method: "GET", headers: { Authorization: auth } });
  }
  const txt = await r.text();
  if (!r.ok) throw new Error(`Script.PutCode HTTP ${r.status}: ${txt}`);
  try { const j = JSON.parse(txt); return j.result ?? j.params ?? j; } catch { return {}; }
}

// ---------- main exported (non-blocking) ----------
export function configureShelly() {
  setImmediate(async () => {
    try {
      if (!SHELLY_IP || !SHELLY_PASS) {
        logger.error("configureShelly: missing SHELLY_IP or SHELLY_PASSWORD in .env");
        return;
      }

      // Build dynamic callback URL (this server IP + port + path)
      const serverIp = getLocalIp();
      const webhookUrl = `${CALLBACK_PROTO}://${serverIp}:${SERVER_PORT}${CALLBACK_PATH}`;
      logger.info(`configureShelly: webhook = ${webhookUrl}`);

      // Build Shelly script with dynamic WEBHOOK_URL
      const SCRIPT_CODE = `// === CONFIG ===
let WEBHOOK_URL   = "${webhookUrl}";
let INVERT_LOGIC  = true;
let DEBOUNCE_MS   = 150;
let TIMEOUT_SEC   = 5;
let MAX_RETRIES   = 3;
let RETRY_BASE_MS = 300;

// === INTERNAL ===
let lastTS = {0:0, 1:0};
let lastState = {0:null, 1:null};

function sendPost(payload, attempt) {
  Shelly.call(
    "HTTP.POST",
    {
      url: WEBHOOK_URL,
      content_type: "application/json",
      body: JSON.stringify(payload),
      timeout: TIMEOUT_SEC
    },
    function (res, err) {
      if (err) {
        if (attempt < MAX_RETRIES) {
          let backoff = RETRY_BASE_MS * (1 << (attempt - 1));
          Timer.set(backoff, false, function () {
            sendPost(payload, attempt + 1);
          });
        } else {
          print("POST failed after retries:", JSON.stringify(err));
        }
        return;
      }
      if (res && res.code >= 200 && res.code < 300) {
        print("POST ok:", res.code, JSON.stringify(payload));
      } else if (attempt < MAX_RETRIES) {
        let backoff = RETRY_BASE_MS * (1 << (attempt - 1));
        Timer.set(backoff, false, function () {
          sendPost(payload, attempt + 1);
        });
      } else {
        print("POST non-2xx:", res ? res.code : -1);
      }
    }
  );
}

Shelly.addStatusHandler(function (e) {
  if (typeof e.component !== "string") return;
  if (e.component.indexOf("input:") !== 0) return;
  if (!e.delta || typeof e.delta.state === "undefined") return;

  let idx = JSON.parse(e.component.split(":")[1]);
  let now = Date.now();

  if (now - lastTS[idx] < DEBOUNCE_MS) return;
  if (lastState[idx] === e.delta.state) return;

  lastTS[idx] = now;
  lastState[idx] = e.delta.state;

  let rawDoor = e.delta.state ? "Open" : "Close";
  let door = INVERT_LOGIC ? (rawDoor === "Open" ? "Close" : "Open") : rawDoor;

  let payload = { Door: door, input: idx, state: e.delta.state, ts: Math.floor(now/1000) };
  sendPost(payload, 1);
});`;

      // 1) Ensure script exists (GET to avoid JSON quirks)
      let id;
      try {
        const list = await rpcGET("Script.List");
        const found = (list.scripts || []).find(s => s.name === SCRIPT_NAME);
        if (found) {
          id = found.id;
        } else {
          await rpcGET("Script.Create", { name: SCRIPT_NAME });
          const list2 = await rpcGET("Script.List");
          id = (list2.scripts || []).find(s => s.name === SCRIPT_NAME)?.id ?? (list2.scripts || [])[0]?.id;
        }
      } catch (e) {
        logger.error(`configureShelly: Script.List/Create failed: ${e.message}`);
        return;
      }

      if (typeof id !== "number") {
        logger.error("configureShelly: could not resolve script id");
        return;
      }

      // 2) Stop running (ignore errors)
      try { await rpcGET("Script.Stop", { id }); } catch (e) { logger.warn(`configureShelly: Script.Stop warn: ${e.message}`); }

      // 3) Upload code in UTF-8 chunks via GET (first overwrite then append)
      try {
        const parts = splitUtf8Bytes(SCRIPT_CODE, CHUNK_BYTES);
        if (!parts.length) throw new Error("empty script");
        await putCodeGET(id, parts[0], false);
        for (let i=1;i<parts.length;i++) await putCodeGET(id, parts[i], true);
      } catch (e) {
        logger.error(`configureShelly: PutCode failed: ${e.message}`);
        return;
      }

      // 4) Enable on boot (GET with config={"enable":true})
      try {
        await rpcGET("Script.SetConfig", { id, config: { enable: true } });
      } catch (e) {
        logger.warn(`configureShelly: SetConfig warn: ${e.message}`);
      }

      // 5) Start now
      try {
        await rpcGET("Script.Start", { id });
        logger.info(`configureShelly: "${SCRIPT_NAME}" uploaded & started (id=${id})`);
      } catch (e) {
        logger.error(`configureShelly: Script.Start failed: ${e.message}`);
      }
    } catch (err) {
      logger.error(`configureShelly fatal: ${err.stack || err.message}`);
    }
  });
}
