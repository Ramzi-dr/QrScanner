// checkAccess.js —

import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { setShellyOutput } from "./shellyOutputs.js";
import { createBookmark } from "./wisenetBookmark.js";
import { doorOpenNotificationLight } from "./doorOpenNotificationLight.js";

dotenv.config({ quiet: true });

const URL = process.env.SPEATER_URL;
const LOCATION_ID = process.env.LOCATION_ID;
const TOKEN = process.env.TOKEN;
const DOOR_OUTPUT = process.env.QR_SCANNER_REST_OUTPUT ?? 0;
const SPAETER_HASH_RAW = process.env.SPAETER_HASH || ""; // string key OR JSON string (wrap JSON in single quotes in .env)

const FILE = path.resolve("./access.json");

// safer default object if file missing/corrupt
const defaultAccessObj = () => ({
  accessControle: { accessState: "noAccess", pendingCounter: 0 },
  door: { doorState: "Close" },
  button: { exitButtonPressed: false },
});

// read JSON if exists
function readFileSafe() {
  try {
    if (fs.existsSync(FILE)) {
      return JSON.parse(fs.readFileSync(FILE, "utf8") || "{}");
    }
  } catch (e) {
    logger.error(`readFileSafe error: ${e.message}`);
  }
  return null;
}

// write JSON
function writeFileSafe(obj) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    logger.error(`writeFileSafe error: ${e.message}`);
  }
}

// Build query params from SPAETER_HASH spec + caller code.
function buildSpaeterParams(callerCode) {
  const params = {};
  const raw = SPAETER_HASH_RAW.trim();

  const addLocationIdIfMissing = () => {
    if (!LOCATION_ID) return;
    const hasLoc = Object.keys(params).some((k) => k.toLowerCase() === "location_id");
    if (!hasLoc) params.location_id = LOCATION_ID;
  };

  if (!raw) {
    params.code = callerCode;
    addLocationIdIfMissing();
    return params;
  }

  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string" && v.toLowerCase() === "code") {
            params[k] = callerCode;
          } else {
            params[k] = v;
          }
        }
        addLocationIdIfMissing();
        return params;
      }
    } catch (e) {
      logger.warn(`SPAETER_HASH JSON parse failed, using string key fallback: ${e.message}`);
    }
  }

  params[raw] = callerCode;
  addLocationIdIfMissing();
  return params;
}

async function fetchSpaeter(code) {
  const maxAttempts = 3;
  let lastErrText = "";

  const q = buildSpaeterParams(code);
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    usp.append(k, v == null ? "" : String(v));
  }

  const target = `${URL}${URL?.includes("?") ? "&" : "?"}${usp.toString()}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (res.ok) {
        try {
          const data = await res.json();
          return { ok: true, data };
        } catch {
          return { ok: true, data: {} };
        }
      }
      const text = await res.text();
      lastErrText = `HTTP ${res.status} ${text || ""}`.trim();
    } catch (err) {
      lastErrText = err?.message || "unknown error";
    }

    if (attempt < maxAttempts) {
      logger.warn(`SPAETER attempt ${attempt}/3 failed: ${lastErrText}`);
      await new Promise((r) => setTimeout(r, 300));
    } else {
      logger.error(`SPAETER failed after 3 attempts: ${lastErrText}`);
      return { ok: false, error: lastErrText };
    }
  }
  return { ok: false, error: lastErrText || "unknown error" };
}

export async function checkAccess(code) {
  if (!URL || !TOKEN) {
    await logger.error("Missing SPEATER_URL or TOKEN in .env");
    return;
  }

  const result = await fetchSpaeter(code);

  // === Handle no response from Spaeter server ===
  if (!result.ok) {
    let fileData = readFileSafe();
    if (!fileData) {
      fileData = defaultAccessObj();
    }
    if (!fileData.accessControle) {
      fileData.accessControle = { accessState: "noAccess", pendingCounter: 0 };
    }

    fileData.accessControle.pendingCounter =
      (fileData.accessControle.pendingCounter || 0) + 1;

    if (fileData.accessControle.pendingCounter <= 3) {
      fileData.accessControle.accessState = "pending";
    } else {
      fileData.accessControle.accessState = "noAccess";
      fileData.accessControle.pendingCounter = 0;
    }

    writeFileSafe(fileData);

    await createBookmark({
      name: "Access Error",
      description: `Failed to validate code ${code} | ${result.error || "no details"}`,
      requested: new Date().toISOString(),
    });
    return;
  }

  const data = result.data || {};
  const granted = Boolean(data.granted);
  const requestedTs = data.requested || new Date().toISOString();
  const customerId = data.customer_id || "n/a";
  const customerName = data.customer_name || "n/a";
  const contactId = data.contact_id || "n/a";
  const fullname = data.fullname || "n/a";

  const line =
    `${granted ? "ACCESS GRANTED" : "NO ACCESS"} | ` +
    `customer: ${customerName} (ID ${customerId}) | user: ${fullname} (contact ${contactId}) | ` +
    `qr: ${code} | time: ${requestedTs}`;
  await logger.info(line);

  // === File handling ===
  let fileData = readFileSafe();
  if (!fileData) {
    fileData = defaultAccessObj();
  }
  if (!fileData.accessControle) {
    fileData.accessControle = { accessState: "noAccess", pendingCounter: 0 };
  }

  if (granted) {
    fileData.accessControle.accessState = "grant";
    fileData.accessControle.pendingCounter = 0;

    setShellyOutput(DOOR_OUTPUT, true)
      .then(() => doorOpenNotificationLight())
      .catch((e) => logger.error(`setShellyOutput error: ${e.message}`));

    await createBookmark({
      name: "✅ Zugang gewährt",
      description: "Tür geöffnet",
      granted,
      requested: requestedTs,
      customer_id: customerId,
      customer_name: customerName,
      contact_id: contactId,
      fullname,
      extraTags: ["QR"],
    });
  } else {
    fileData.accessControle.accessState = "noAccess";
    fileData.accessControle.pendingCounter = 0;

    await createBookmark({
      name: "🚫 Zugang verweigert",
      description: "Zutritt verweigert",
      granted,
      requested: requestedTs,
      customer_id: customerId,
      customer_name: customerName,
      contact_id: contactId,
      fullname,
      extraTags: ["QR"],
    });
  }

  writeFileSafe(fileData);
}
