// state.js — manages ./access.json based on Shelly Pro 3 inputs
// - Robust: digest-auth, timeouts, retries, safe JSON handling
// - Non-blocking for callers: never throws; logs errors and returns the latest object (or null on fatal)
// - Door logic FLIPPED: close contact (true) => door "Close", open contact (false) => door "Open"

import dotenv from "dotenv";
dotenv.config();
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import http from "http";
import crypto from "crypto";
import logger from "./logger.js";

dotenv.config({ quiet: true });

const SHELLY_IP   = process.env.SHELLY_IP || "192.168.76.176";
const SHELLY_USER = process.env.SHELLY_USER || "admin";
const SHELLY_PASS = process.env.SHELLY_PASSWORD || "CHANGE_ME";
const SHELLY_PORT = Number(process.env.SHELLY_PORT || 80);

const FILE_PATH = path.resolve("./access.json");
const INPUT_IDS = [0, 1, 2];

const HTTP_TIMEOUT_MS = 3000;
const MAX_TRIES = 2;

// ---- helpers: digest auth (SHA-256) ----
function parseDigest(header) {
  const parts = {};
  (header || "").replace(/([a-z0-9\-]+)="?([^",]+)"?/gi, (_m, k, v) => (parts[k] = v));
  return parts;
}
function buildDigestSHA256({ realm, nonce, qop }, method, uri, user, pass, nc, cnonce) {
  const ha1 = crypto.createHash("sha256").update(`${user}:${realm}:${pass}`).digest("hex");
  const ha2 = crypto.createHash("sha256").update(`${method}:${uri}`).digest("hex");
  const resp = crypto.createHash("sha256").update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest("hex");
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=SHA-256, response="${resp}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
}

// ---- Shelly RPC: Input.GetStatus(id) (safe) ----
async function fetchInputOnce(id) {
  return new Promise((resolve, reject) => {
    const pathStr = `/rpc/Input.GetStatus?id=${id}`;
    const opts = { host: SHELLY_IP, port: SHELLY_PORT, path: pathStr, method: "GET", timeout: HTTP_TIMEOUT_MS };

    const req1 = http.request(opts, (res1) => {
      let b = "";
      res1.on("data", (d) => (b += d));
      res1.on("end", () => {
        if (res1.statusCode === 200) {
          try { return resolve(JSON.parse(b || "{}")); } catch { return resolve({}); }
        }
        if (res1.statusCode !== 401) return reject(new Error(`Unexpected ${res1.statusCode}`));

        const chal = parseDigest(res1.headers["www-authenticate"]);
        const nc = "00000001";
        const cnonce = crypto.randomBytes(8).toString("hex");
        const Authorization = buildDigestSHA256(chal, "GET", pathStr, SHELLY_USER, SHELLY_PASS, nc, cnonce);

        const req2 = http.request({ ...opts, headers: { Authorization } }, (res2) => {
          let b2 = "";
          res2.on("data", (d) => (b2 += d));
          res2.on("end", () => {
            if (res2.statusCode === 200) {
              try { return resolve(JSON.parse(b2 || "{}")); } catch { return resolve({}); }
            }
            return reject(new Error(`Auth failed ${res2.statusCode}`));
          });
        });
        req2.on("error", reject);
        req2.end();
      });
    });
    req1.on("error", reject);
    req1.end();
  });
}

async function fetchInput(id) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetchInputOnce(id);
      return res;
    } catch (e) {
      if (attempt < MAX_TRIES) {
        const backoff = 150 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        logger.error(`Input.GetStatus id=${id} failed: ${e?.message || e}`);
        return null; // tolerate failure
      }
    }
  }
  return null;
}

// ---- file helpers ----
function defaultAccess() {
  return {
    button: { exitButtonPressed: false },
    door: { doorState: "Close" },
    reserveInput: { inputState: "off" },
    accessControle: { accessState: "noAccess" },
  };
}

async function loadAccessFile() {
  try {
    if (!fssync.existsSync(FILE_PATH)) return defaultAccess();

    const txt = await fs.readFile(FILE_PATH, "utf8");
    try {
      const parsed = JSON.parse(txt);
      // ensure shape
      if (!parsed.button) parsed.button = { exitButtonPressed: false };
      if (!parsed.door) parsed.door = { doorState: "Close" };
      if (!parsed.reserveInput) parsed.reserveInput = { inputState: "off" };
      if (!parsed.accessControle || typeof parsed.accessControle.accessState !== "string") {
        parsed.accessControle = { accessState: "noAccess" };
      }
      return parsed;
    } catch {
      // try to fix trailing commas
      const fixed = txt.replace(/,\s*([}\]])/g, "$1");
      try {
        const parsed2 = JSON.parse(fixed);
        if (!parsed2.button) parsed2.button = { exitButtonPressed: false };
        if (!parsed2.door) parsed2.door = { doorState: "Close" };
        if (!parsed2.reserveInput) parsed2.reserveInput = { inputState: "off" };
        if (!parsed2.accessControle || typeof parsed2.accessControle.accessState !== "string") {
          parsed2.accessControle = { accessState: "noAccess" };
        }
        return parsed2;
      } catch {
        logger.warn("access.json invalid JSON; resetting to defaults");
        return defaultAccess();
      }
    }
  } catch (e) {
    logger.error(`loadAccessFile error: ${e?.message || e}`);
    return defaultAccess();
  }
}

async function saveAccessFile(obj) {
  try {
    const tmp = FILE_PATH + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, FILE_PATH);
  } catch (e) {
    logger.error(`saveAccessFile error: ${e?.message || e}`);
  }
}

// ---- main exported function ----
// Never throws; returns updated object or null on fatal.
export async function updateAccessFile() {
  try {
    // Load current state first so we can patch only what we actually read
    const data = await loadAccessFile();

    // Fetch all inputs (tolerate per-input failure)
    const results = await Promise.allSettled(INPUT_IDS.map((id) => fetchInput(id)));

    const in0 = results[0].status === "fulfilled" ? results[0].value : null; // exit button
    const in1 = results[1].status === "fulfilled" ? results[1].value : null; // door contact
    const in2 = results[2].status === "fulfilled" ? results[2].value : null; // reserve

    // Patch ONLY fields we successfully obtained
    if (in0 && typeof in0.state !== "undefined") {
      data.button = { exitButtonPressed: !!in0.state };
    }

    if (in1 && typeof in1.state !== "undefined") {
      // 🔁 FLIPPED DOOR LOGIC:
      // close contact (true)  => "Close"
      // open  contact (false) => "Open"
      data.door = { doorState: in1.state ? "Close" : "Open" };
    }

    if (in2 && typeof in2.state !== "undefined") {
      data.reserveInput = { inputState: in2.state ? "on" : "off" };
    }

    // Make sure accessControle exists and is sane (but DO NOT alter its current value otherwise)
    if (!data.accessControle || typeof data.accessControle.accessState !== "string") {
      data.accessControle = { accessState: "noAccess" };
    }

    await saveAccessFile(data);
    return data;
  } catch (e) {
    logger.error(`updateAccessFile fatal: ${e?.stack || e?.message || e}`);
    return null;
  }
}
