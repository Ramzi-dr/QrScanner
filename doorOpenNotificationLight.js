// doorOpenNotificationLight.js
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import crypto from "crypto";

const DEFAULT_IP = process.env.QR_SCANNER_IP;
const DEFAULT_USER = process.env.QR_SCANNER_USER;
const DEFAULT_PASS = process.env.QR_SCANNER_PASS;
const TIMEOUT_MS = 4000;

// Parse WWW-Authenticate header (Digest)
function parseDigestHeader(header) {
  const pairs = [...(header || "").matchAll(/(\w+)="?([^",]+)"?/g)];
  const result = {};
  for (const [, k, v] of pairs) result[k] = v;
  return result;
}

// Non-blocking door open (fire-and-forget)
export function doorOpenNotificationLight(
  ip = DEFAULT_IP,
  user = DEFAULT_USER,
  password = DEFAULT_PASS,
  doorId = 1,
) {
  ("🔓 Door open notification voice...");
  // Return immediately; run async in background
  (async () => {
    if (!ip || !user || !password) {
      console.error(
        "❌ Missing QR_SCANNER_IP/USER/PASS in .env or function args.",
      );
      return;
    }

    const url = `http://${ip}/ISAPI/AccessControl/RemoteControl/door/${doorId}`;
    const uri = `/ISAPI/AccessControl/RemoteControl/door/${doorId}`;
    const payload = `<?xml version="1.0" encoding="UTF-8"?>
<RemoteControlDoor xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <cmd>open</cmd>
</RemoteControlDoor>`;

    // Helper: fetch with timeout
    const withTimeout = (resource, options = {}) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
      return fetch(resource, { ...options, signal: controller.signal }).finally(
        () => clearTimeout(id),
      );
    };

    try {
      // 1) Initial unauthenticated request to get Digest challenge
      const r1 = await withTimeout(url, {
        method: "PUT",
        body: payload,
        headers: { "Content-Type": "application/xml" },
      });

      if (r1.status !== 401 || !r1.headers.has("www-authenticate")) {
        if (r1.status === 200) {
          ("✅ Door opened (no auth required).");
          return;
        }
        console.error(`❌ Unexpected response: HTTP ${r1.status}`);
        return;
      }

      // 2) Build Digest auth (MD5, no qop)
      const authData = parseDigestHeader(r1.headers.get("www-authenticate"));
      const realm = authData.realm;
      const nonce = authData.nonce;
      const method = "PUT";

      const ha1 = crypto
        .createHash("md5")
        .update(`${user}:${realm}:${password}`)
        .digest("hex");
      const ha2 = crypto
        .createHash("md5")
        .update(`${method}:${uri}`)
        .digest("hex");
      const response = crypto
        .createHash("md5")
        .update(`${ha1}:${nonce}:${ha2}`)
        .digest("hex");

      const authHeader =
        `Digest username="${user}", realm="${realm}", nonce="${nonce}", ` +
        `uri="${uri}", response="${response}", algorithm="MD5"`;

      // 3) Authenticated request
      const r2 = await withTimeout(url, {
        method: "PUT",
        body: payload,
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/xml",
        },
      });

      if (r2.status === 200) {
        ("✅ Door opened.");
      } else {
        const text = await r2.text().catch(() => "");
        console.error(`❌ Door open failed. Status: ${r2.status} | ${text}`);
      }
    } catch (err) {
      console.error(`❌ Exception during door open: ${err}`);
    }
  })();
}
