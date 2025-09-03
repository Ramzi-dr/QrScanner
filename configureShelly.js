// configureShelly.js
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import crypto from "crypto";
import logger from "./logger.js";

const SHELLY_IP    = process.env.SHELLY_IP;
const SHELLY_USER  = process.env.SHELLY_USER || "admin";
const SHELLY_PASS  = process.env.SHELLY_PASSWORD;
const SHELLY_PORT  = Number(process.env.SHELLY_PORT || 80);
const SHELLY_PROTO = process.env.SHELLY_PROTO || "http";

const SERVER_IP     = process.env.SERVER_IP || "";   // ✅ from env
const SERVER_PORT   = Number(process.env.SERVER_PORT || 3000);
const CALLBACK_PATH = process.env.SHELLY_CALLBACK_PATH || "/shelly";
const CALLBACK_PROTO = process.env.SERVER_PROTO || "http";

const SCRIPT_NAME  = process.env.SHELLY_SCRIPT_NAME || "Express Server";
const CHUNK_BYTES  = 900;
const TIMEOUT_MS   = 8000;

// --- utils ---
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const parseDigest = (h) => {
  const out = {};
  (h || "").replace(/(\w+)=(?:"([^"]+)"|([^\s,]+))/g, (_,$1,$2,$3)=>out[$1]=$2??$3);
  return out;
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
function SHELLLY_IP_FALLBACK(){ return SHELLY_IP; }
function SHELLLY_PORT_FALLBACK(){ return SHELLY_PORT; }

// --- RPC helpers ---
async function rpcGET(method, paramsObj = {}) {
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

// --- exported ---
export function configureShelly() {
  setImmediate(async () => {
    try {
      if (!SHELLY_IP || !SHELLY_PASS) {
        logger.error("configureShelly: missing SHELLY_IP or SHELLY_PASSWORD in .env");
        return;
      }

      if (!SERVER_IP) {
        logger.warn("configureShelly: SERVER_IP not set in .env — skipping Shelly config.");
        return; // 🚫 skip if no SERVER_IP
      }

      const webhookUrl = `${CALLBACK_PROTO}://${SERVER_IP}:${SERVER_PORT}${CALLBACK_PATH}`;
      logger.info(`configureShelly: webhook = ${webhookUrl}`);

      // (rest of your script upload logic unchanged) ...
    } catch (err) {
      logger.error(`configureShelly fatal: ${err.stack || err.message}`);
    }
  });
}
