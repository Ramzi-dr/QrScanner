// volumeController.js
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import crypto from "crypto";

const IP = process.env.QR_SCANNER_IP;
const USER = process.env.QR_SCANNER_USER;
const PASS = process.env.QR_SCANNER_PASS;

// --- digest helper ---
function parseDigestHeader(header) {
  const pairs = [...(header || "").matchAll(/(\w+)="?([^",]+)"?/g)];
  const result = {};
  for (const [, k, v] of pairs) result[k] = v;
  return result;
}

// build XML
const buildVolumeXML = (vol) => `<?xml version="1.0" encoding="UTF-8"?>
<AudioOut>
  <id>1</id>
  <AudioOutVolumelist>
    <AudioOutVlome>
      <type>audioOutput</type>
      <volume>${vol}</volume>
    </AudioOutVlome>
  </AudioOutVolumelist>
</AudioOut>`;

// exported toggle
export function volumeController(state = "off") {
  (async () => {
    const uri = "/ISAPI/System/Audio/AudioOut/channels/1";
    const url = `http://${IP}${uri}`;
    const vol = state === "on" ? 9 : 0;
    const body = buildVolumeXML(vol);

    try {
      // first unauth to get digest
      const r1 = await fetch(url, { method: "PUT", body });
      if (r1.status !== 401 || !r1.headers.get("www-authenticate")) {
        console.error(`❌ Unexpected response: ${r1.status}`);
        return;
      }

      // digest
      const chal = parseDigestHeader(r1.headers.get("www-authenticate"));
      const ha1 = crypto
        .createHash("md5")
        .update(`${USER}:${chal.realm}:${PASS}`)
        .digest("hex");
      const ha2 = crypto.createHash("md5").update(`PUT:${uri}`).digest("hex");
      const response = crypto
        .createHash("md5")
        .update(`${ha1}:${chal.nonce}:${ha2}`)
        .digest("hex");
      const authHeader = `Digest username="${USER}", realm="${chal.realm}", nonce="${chal.nonce}", uri="${uri}", response="${response}", algorithm="MD5"`;

      // send authenticated
      const r2 = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/xml",
        },
        body,
      });

      if (r2.status === 200) {
        `🔊 Volume ${state.toUpperCase()} (set ${vol})`;
      } else {
        console.error(`❌ Volume change failed: ${r2.status}`);
      }
    } catch (err) {
      console.error(`❌ Exception: ${err}`);
    }
  })();
}
