/**
 * wisenetBookmark.js
 * ------------------
 * - Flexible: supports one or many device IDs from .env or per-call
 * - Accepts:
 *    • createBookmark("free text message")
 *    • createBookmark({ message, name, startTimeMs, durationMs, tags, kvTags, extras, deviceIds })
 * - tags: array|string|object (kvTags) → normalized to ["key:value", ...]
 * - Parallel with Promise.allSettled; logs errors; never throws
 * - Returns per-device results: { deviceId, success, data?, error? }
 */

import fetch from "node-fetch";
import https from "https";
import dotenv from "dotenv";
dotenv.config();
import logger from "./logger.js";

dotenv.config({ override: true });

const SERVER   = process.env.WISENET_SERVER;
const USERNAME = process.env.WISENET_USER;
const PASSWORD = process.env.WISENET_PASS;

// .env cameras: WISENET_DEVICEIDS=ID1,ID2 or fallback WISENET_DEVICEID
const ENV_DEVICE_IDS = (process.env.WISENET_DEVICEIDS
  ? process.env.WISENET_DEVICEIDS.split(",")
  : []
).map(s => s.trim()).filter(Boolean);

if (ENV_DEVICE_IDS.length === 0 && !process.env.WISENET_DEVICEID) {
  logger.warn("⚠️ No WISENET_DEVICEIDS or WISENET_DEVICEID configured in .env");
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

async function apiCall(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, agent: insecureAgent });
    const text = await res.text();
    if (!res.ok) {
      const errMsg = `API ${url} failed: ${res.status} ${text}`;
      await logger.error(errMsg);
      return { error: errMsg };
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    const errMsg = `Fetch error for ${url}: ${err.message}`;
    await logger.error(errMsg);
    return { error: errMsg };
  }
}

async function login() {
  const url  = `${SERVER}/rest/v3/login/sessions`;
  const body = { username: USERNAME, password: PASSWORD };
  const data = await apiCall(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data?.token || null;
}

async function getTicket(loginToken) {
  const url = `${SERVER}/rest/v3/login/tickets`;
  const data = await apiCall(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginToken}`,
    },
  });
  return data?.token || null;
}

// Normalize tags input to array of strings
function buildTags({ tags, kvTags, granted } = {}) {
  const out = new Set(["api"]);

  // dynamic access tag if provided
  if (granted === true) out.add("ACCESS_GRANTED");
  else if (granted === false) out.add("ACCESS_DENIED");
  else out.add("ACCESS_UNKNOWN");

  // array or comma string
  if (Array.isArray(tags)) tags.forEach(t => t && out.add(String(t)));
  else if (typeof tags === "string") tags.split(",").forEach(t => t && out.add(t.trim()));

  // object → key:value
  if (kvTags && typeof kvTags === "object") {
    for (const [k, v] of Object.entries(kvTags)) {
      if (k && v !== undefined && v !== null) out.add(`${k}:${v}`);
    }
  }

  return Array.from(out);
}

// Build description from message + extras/known fields
function buildDescription({ message, description, extras = {}, known = {} }) {
  const base = message ?? description ?? "Created via API";
  const parts = [];

  // known fields first (only those provided)
  for (const [k, v] of Object.entries(known)) {
    if (v !== undefined && v !== null && v !== "") parts.push(`${k}: ${v}`);
  }
  // arbitrary extras (object)
  if (extras && typeof extras === "object") {
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined && v !== null && v !== "") parts.push(`${k}: ${v}`);
    }
  }

  return parts.length ? `${base} | ${parts.join(" | ")}` : base;
}

/**
 * createBookmark
 *  - Overloads:
 *      createBookmark("free text message")
 *      createBookmark({ message, name, startTimeMs, durationMs, tags, kvTags, extras, deviceIds, granted, requested, ... })
 */
export async function createBookmark(input = {}) {
  // support string shorthand: createBookmark("message")
  const opts = (typeof input === "string") ? { message: input } : (input || {});

  const {
    // display
    name = "API Bookmark",
    message,                       // → preferred textual message
    description,                   // fallback text if message not provided

    // time window
    startTimeMs = Date.now() - 3000,
    durationMs  = 9000,

    // access-related (optional)
    granted,
    requested,
    customer_id,
    customer_name,
    contact_id,
    fullname,

    // flexible metadata
    tags,
    kvTags,
    extras,
    deviceIds,                     // override .env devices for this call
  } = opts;

  try {
    const loginToken = await login();
    if (!loginToken) {
      await logger.error("❌ Login failed");
      return null;
    }

    // choose devices
    const devices = (deviceIds && deviceIds.length)
      ? deviceIds
      : (ENV_DEVICE_IDS.length ? ENV_DEVICE_IDS : [process.env.WISENET_DEVICEID]).filter(Boolean);

    if (!devices.length) {
      await logger.warn("⚠️ No device IDs resolved to send bookmark");
      return [];
    }

    // Build description + tags
    const finalDescription = buildDescription({
      message,
      description,
      extras,
      known: {
        Granted: granted,
        Requested: requested,
        CustomerID: customer_id,
        Customer: customer_name,
        ContactID: contact_id,
        Fullname: fullname,
      },
    });

    const finalTags = buildTags({ tags, kvTags, granted });

    // Parallel per device — each gets its own ticket
    const promises = devices.map(async (deviceId) => {
      try {
        const ticket = await getTicket(loginToken);
        if (!ticket) {
          const msg = `❌ Ticket request failed for device ${deviceId}`;
          await logger.error(msg);
          return { deviceId, success: false, error: msg };
        }

        const url = `${SERVER}/rest/v3/devices/${deviceId}/bookmarks?_ticket=${encodeURIComponent(ticket)}`;
        const payload = { name, description: finalDescription, startTimeMs, durationMs, tags: finalTags };

        const data = await apiCall(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (data && !data.error) {
          await logger.info(`✅ Bookmark created on device ${deviceId} | name: ${name}`);
          return { deviceId, success: true, data };
        } else {
          const errMsg = data?.error || `Unknown error on device ${deviceId}`;
          await logger.error(`❌ Failed to create bookmark on device ${deviceId}: ${errMsg}`);
          return { deviceId, success: false, error: errMsg };
        }
      } catch (err) {
        const errMsg = `Bookmark exception on device ${deviceId}: ${err.message}`;
        await logger.error(`❌ ${errMsg}`);
        return { deviceId, success: false, error: errMsg };
      }
    });

    const settled = await Promise.allSettled(promises);
    const results = settled.map((s) =>
      s.status === "fulfilled" ? s.value : { deviceId: "unknown", success: false, error: String(s.reason) }
    );

    return results;
  } catch (err) {
    const errMsg = `Bookmark creation error: ${err.message}`;
    await logger.error(`❌ ${errMsg}`);
    return null;
  }
}
