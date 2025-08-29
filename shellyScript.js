// // === CONFIG ===
// let WEBHOOK_URL   = "http://192.168.76.206:3000/shelly";
// let INVERT_LOGIC  = true;
// let DEBOUNCE_MS   = 150;
// let TIMEOUT_SEC   = 5;
// let MAX_RETRIES   = 3;
// let RETRY_BASE_MS = 300;

// // === INTERNAL ===
// let lastTS = {0:0, 1:0};
// let lastState = {0:null, 1:null};

// function sendPost(payload, attempt) {
//   Shelly.call(
//     "HTTP.POST",
//     {
//       url: WEBHOOK_URL,
//       content_type: "application/json",
//       body: JSON.stringify(payload),
//       timeout: TIMEOUT_SEC
//     },
//     function (res, err) {
//       if (err) {
//         if (attempt < MAX_RETRIES) {
//           let backoff = RETRY_BASE_MS * (1 << (attempt - 1));
//           Timer.set(backoff, false, function () {
//             sendPost(payload, attempt + 1);
//           });
//         } else {
//           print("❌ POST failed after retries:", JSON.stringify(err));
//         }
//         return;
//       }
//       if (res && res.code >= 200 && res.code < 300) {
//         print("✅ POST ok:", res.code, JSON.stringify(payload));
//       } else if (attempt < MAX_RETRIES) {
//         let backoff = RETRY_BASE_MS * (1 << (attempt - 1));
//         Timer.set(backoff, false, function () {
//           sendPost(payload, attempt + 1);
//         });
//       } else {
//         print("❌ POST non-2xx:", res ? res.code : -1);
//       }
//     }
//   );
// }

// Shelly.addStatusHandler(function (e) {
//   if (typeof e.component !== "string") return;
//   if (e.component.indexOf("input:") !== 0) return;   // instead of startsWith()

//   if (!e.delta || typeof e.delta.state === "undefined") return;

//   let inputIndex = JSON.parse(e.component.split(":")[1]);  // 0 or 1
//   let now = Date.now();

//   if (now - lastTS[inputIndex] < DEBOUNCE_MS) return;
//   if (lastState[inputIndex] === e.delta.state) return;

//   lastTS[inputIndex] = now;
//   lastState[inputIndex] = e.delta.state;

//   let rawDoor = e.delta.state ? "Open" : "Close";
//   let door = INVERT_LOGIC ? (rawDoor === "Open" ? "Close" : "Open") : rawDoor;

//   let payload = {
//     Door: door,
//     input: inputIndex,
//     state: e.delta.state,
//     ts: Math.floor(now / 1000)
//   };

//   sendPost(payload, 1);

// });