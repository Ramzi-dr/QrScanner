// configureQrScanner.js
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import crypto from "crypto";
import https from "https";
import os from "os";
import logger from "./logger.js";

const HIK_IP   = process.env.QR_SCANNER_IP;        // camera IP (e.g., 192.168.76.155)
const HIK_USER = process.env.QR_SCANNER_USER;
const HIK_PASS = process.env.QR_SCANNER_PASS;

const CALLBACK_PATH = process.env.QR_CALLBACK_PATH || "/qrScanner";
const SERVER_PORT   = Number(process.env.SERVER_PORT || 3000); // <-- use SERVER_PORT
const SECURITY      = String(process.env.QR_SECURITY || "1");  // query ?security=1
const IV            = process.env.QR_IV || "";                 // optional &iv=...

const TIMEOUT_MS = 5000;
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// --- helpers ---
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function parseDigestHeader(header) {
  const pairs = [...(header || "").matchAll(/(\w+)=(?:"([^"]+)"|([^\s,]+))/g)];
  const out = {};
  for (const [, k, v1, v2] of pairs) out[k] = v1 ?? v2;
  return out;
}

function buildXml({ path, ip, port }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotification>
  <id>1</id>
  <url>${path}</url>
  <protocolType>HTTP</protocolType>
  <parameterFormatType>XML</parameterFormatType>
  <addressingFormatType>ipaddress</addressingFormatType>
  <ipAddress>${ip}</ipAddress>
  <portNo>${port}</portNo>
  <httpAuthenticationMethod>none</httpAuthenticationMethod>
</HttpHostNotification>`;
}

function withTimeout(resource, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(resource, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

function buildAuthHeader(method, uri, chal, user, pass) {
  const realm = chal.realm;
  const nonce = chal.nonce;
  const qop = (chal.qop || "").split(",").map(s => s.trim()).find(v => v === "auth");
  const opaque = chal.opaque;

  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);

  if (qop) {
    const cnonce = crypto.randomBytes(8).toString("hex");
    const nc = "00000001";
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}", algorithm=MD5${opaque ? `, opaque="${opaque}"` : ""}`;
  }
  const response = md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5${opaque ? `, opaque="${opaque}"` : ""}`;
}

// --- exported: fire-and-forget (non-blocking) ---
export function configureQrScanner() {
  // return immediately; run async in background
  setImmediate(() => {
    if (!HIK_IP || !HIK_USER || !HIK_PASS) {
      logger.error("configureQrScanner: missing QR_SCANNER_IP/USER/PASS in .env");
      return;
    }

    const localIp = getLocalIp();
    logger.info(`configureQrScanner: using server IP ${localIp}:${SERVER_PORT}`);

    const pathname = `/ISAPI/Event/notification/httpHosts/1`;
    const search = `?security=${encodeURIComponent(SECURITY)}${IV ? `&iv=${encodeURIComponent(IV)}` : ""}`;
    const fullUrl = `https://${HIK_IP}${pathname}${search}`;
    const uriForDigest = `${pathname}${search}`;
    const xml = buildXml({ path: CALLBACK_PATH, ip: localIp, port: SERVER_PORT });

    // 1) Initial unauthenticated PUT to get digest challenge (or succeed if open)
    withTimeout(fullUrl, {
      method: "PUT",
      body: xml,
      headers: { "Content-Type": "application/xml" },
      agent: httpsAgent,
    })
      .then(async (r1) => {
        if (r1.status === 200) {
          logger.info("configureQrScanner: config applied without auth (HTTP 200).");
          return null; // done
        }

        const www = r1.headers.get("www-authenticate");
        if (r1.status !== 401 || !www) {
          const text = await r1.text().catch(() => "");
          logger.error(`configureQrScanner: unexpected response ${r1.status} ${text}`);
          return null; // stop
        }

        const chal = parseDigestHeader(www);
        const authHeader = buildAuthHeader("PUT", uriForDigest, chal, HIK_USER, HIK_PASS);

        // 2) Authenticated PUT
        return withTimeout(fullUrl, {
          method: "PUT",
          body: xml,
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/xml",
          },
          agent: httpsAgent,
        });
      })
      .then(async (r2) => {
        if (!r2) return; // already handled or failed earlier
        if (r2.status === 200) {
          logger.info("configureQrScanner: QR HTTP host configured (HTTP 200).");
        } else {
          const text = await r2.text().catch(() => "");
          logger.error(`configureQrScanner: authenticated PUT failed ${r2.status} ${text}`);
        }
      })
      .catch((err) => {
        logger.error(`configureQrScanner: exception ${err?.message || err}`);
      });
  });
}
