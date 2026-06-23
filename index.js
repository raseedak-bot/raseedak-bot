const https = require("https");
const http = require("http");
const fs = require("fs");

const TG_TOKEN = process.env.TG_TOKEN || "";
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./data.json";

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch(e) { return { drivers: {}, shifts: [], invoices: [] }; }
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch(e) {}
}

function tgReq(method, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: "api.telegram.org",
      path: "/bot" + TG_TOKEN + "/" + method,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    });
    req.on("error", () => resolve({}));
    req.write(data); req.end();
  });
}

function sendMsg(chatId, text, keyboard) {
  const body = { chat_id: chatId, text: text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = { keyboard: keyboard, resize_keyboard: true };
  return tgReq("sendMessage", body);
}

function sendInline(chatId, text, inline_keyboard) {
  return tgReq("sendMessage", { chat_id: chatId, text: text, parse_mode: "HTML", reply_markup: { inline_keyboard: inline_keyboard } });
}

function getFileUrl(fileId) {
  return tgReq("getFile", { file_id: fileId }).then(function(r) {
    return r.ok ? "https://api.telegram.org/file/bot" + TG_TOKEN + "/" + r.result.file_path : null;
  });
}

function analyzeImage(imageUrl, prompt) {
  return new Promise(function(resolve) {
    const cleanKey = (CLAUDE_KEY || "").trim().replace(/[\r\n\t]/g, "");
    if (!cleanKey) return resolve({ error: "No API key" });
    https.get(imageUrl, function(imgRes) {
      const chunks = [];
      imgRes.on("data", function(c) { chunks.push(c); });
      imgRes.on("end", function() {
        const b64 = Buffer.concat(chunks).toString("base64");
        const mediaType = imgRes.headers["content-type"] || "image/jpeg";
        const body = JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: prompt }
          ]}]
        });
        const opts = {
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body, "utf8"),
            "x-api-key": cleanKey,
            "anthropic-version": "2023-06-01"
          }
        };
        const req = https.request(opts, function(res) {
          let raw = "";
          res.on("data", function(c) { raw += c; });
          res.on("end", function() {
            try {
              const d = JSON.parse(raw);
              const txt = d.content && d.content[0] ? d.content[0].text : "";
              const jsonMatch = txt.match(/\{[\s\S]*?\}/);
              if (jsonMatch) {
                try { return resolve(JSON.parse(jsonMatch[0])); } catch(e) {}
              }
              return resolve({ error: "Could not parse: " + txt.slice(0, 50) });
            } catch(e) { resolve({ error: e.message }); }
          });
        });
        req.on("error", function(e) { resolve({ error: e.message }); });
        req.write(body); req.end();
      });
    }).on("error", function(e) { resolve({ error: e.message }); });
  });
}

const MENU_AR = [["📋 إرسال فاتورة", "🚗 بداية الوردية"], ["🏁 نهاية الوردية", "📊 إحصائياتي"]];
const MENU_EN = [["📋 Send Invoice", "🚗 Start Shift"], ["🏁 End Shift", "📊 My Stats"]];
const userStates = {};
const processedIds = new Set();
const userLang = {};
const processedUpdates = new Set();

function getLang(userId) { return userLang[userId] || "ar"; }
function t(userId, ar, en) { return getLang(userId) === "ar" ? ar : en; }
function menu(userId) { return getLang(userId) === "ar" ? MENU_AR : MENU_EN; }

const processed = new Set();
async function handleUpdate(update) {
  if (processed.has(update.update_id)) return;
  processed.add(update.update_id);
  if (processed.size > 1000) processed.clear();
  if (processedUpdates.has(update.update_id)) return;
  processedUpdates.add(update.update_id);
  if (processedUpdates.size > 500) {
    const first = processedUpdates.values().next().value;
    processedUpdates.delete(first);
  }

  const msg = update.message;
  const cb = update.callback_query;
  if (!msg && !cb) return;

  const chatId = cb ? cb.message.chat.id : msg.chat.id;
  const userId = String(cb ? cb.from.id : msg.from.id);
  const firstName = cb ? cb.from.first_name : msg.from.first_name;
  const text = cb ? cb.data : (msg.text || "");
  const photo = msg && msg.photo;
  const data = loadData();
  const driver = data.drivers[userId];
  const isOwner = parseInt(userId) === OWNER_ID;
  const lang = getLang(userId);

  // Callback: register driver
  if (cb && text.startsWith("reg_")) {
    const parts = text.split("_");
    const newId = parts[1];
    const newName = parts.slice(2).join("_");
    data.drivers[newId] = { name: newName, chatId: parseInt(newId), registeredAt: new Date().toISOString() };
    saveData(data);
    await tgReq("answerCallbackQuery", { callback_query_id: cb.id, text: "✅" });
    await sendMsg(chatId, "✅ تم تسجيل " + newName);
    await sendMsg(parseInt(newId), "🎉 تم تسجيلك! اكتب /start", MENU_AR);
    return;
  }

  // Callback: approve/reject
  if (cb && (text.startsWith("app_") || text.startsWith("rej_"))) {
    const parts = text.split("_");
    const action = parts[0];
    const invId = parseInt(parts[1]);
    const inv = data.invoices.find(function(i) { return i.id === invId; });
    if (!inv) { await tgReq("answerCallbackQuery", { callback_query_id: cb.id }); return; }
    if (action === "app") {
      inv.approved = true; inv.pending = false; inv.approvedAt = new Date().toISOString();
      saveData(data);
      await tgReq("answerCallbackQuery", { callback_query_id: cb.id, text: "✅" });
      await sendMsg(parseInt(inv.driverId), "✅ تمت الموافقة على فاتورتك\n💰 " + Number(inv.amount).toFixed(3) + " د.ك");
      await sendMsg(chatId, "✅ تمت الموافقة على فاتورة " + inv.driverName);
    } else {
      inv.approved = false; inv.pending = false; inv.rejected = true;
      saveData(data);
      await tgReq("answerCallbackQuery", { callback_query_id: cb.id, text: "❌" });
      await sendMsg(parseInt(inv.driverId), "❌ تم رفض فاتورتك. تواصل مع المشرف.");
      await sendMsg(chatId, "❌ تم رفض فاتورة " + inv.driverName);
    }
    return;
  }

  // Language selection callback
  if (cb && (text === "lang_ar" || text === "lang_en")) {
    userLang[userId] = text === "lang_ar" ? "ar" : "en";
    await tgReq("answerCallbackQuery", { callback_query_id: cb.id });
    const name = driver ? driver.name : firstName;
    await sendMsg(chatId, t(userId, "👋 مرحباً " + name + "! اختر من القائمة:", "👋 Hello " + name + "! Choose from menu:"), menu(userId));
    return;
  }

  // Unregistered
  if (!driver && !isOwner) {
    await sendMsg(chatId, "🔒 حسابك غير مسجل\n\n👤 اسمك: " + firstName + "\n🆔 ID: " + userId + "\n\nأرسل هذا المعرف لمشرفك.");
    if (OWNER_ID) {
      await sendInline(OWNER_ID,
        "📬 طلب تسجيل جديد\n👤 " + firstName + "\n🆔 " + userId,
        [[{ text: "✅ تسجيل " + firstName, callback_data: "reg_" + userId + "_" + firstName }]]
      );
    }
    return;
  }

  // /start - show language selection
  if (text === "/start") {
    await sendInline(chatId, "🌐 اختر اللغة / Choose language:", [[
      { text: "🇸🇦 العربية", callback_data: "lang_ar" },
      { text: "🇬🇧 English", callback_data: "lang_en" }
    ]]);
    return;
  }

  // Invoice
  if (text === "📋 إرسال فاتورة" || text === "📋 Send Invoice") {
    userStates[userId] = "invoice";
    await sendMsg(chatId, t(userId, "📸 أرسل صورة الفاتورة.", "📸 Send a photo of the invoice."));
    return;
  }

  // Start shift
  if (text === "🚗 بداية الوردية" || text === "🚗 Start Shift") {
    const today = new Date().toISOString().split("T")[0];
    if (data.shifts.find(function(s) { return s.driverId === userId && s.date === today && !s.endKm; })) {
      await sendMsg(chatId, t(userId, "⚠️ عندك وردية مفتوحة اليوم.", "⚠️ You have an open shift today.")); return;
    }
    userStates[userId] = "start_km";
    await sendMsg(chatId, t(userId, "📸 أرسل صورة عداد السيارة (البداية).", "📸 Send odometer photo (start).")); return;
  }

  // End shift
  if (text === "🏁 نهاية الوردية" || text === "🏁 End Shift") {
    const today = new Date().toISOString().split("T")[0];
    const open = data.shifts.find(function(s) { return s.driverId === userId && s.date === today && !s.endKm; });
    if (!open) { await sendMsg(chatId, t(userId, "⚠️ لا توجد وردية مفتوحة.", "⚠️ No open shift found.")); return; }
    userStates[userId] = "end_km";
    await sendMsg(chatId, t(userId, "📸 أرسل صورة عداد السيارة (النهاية).\nبداية: " + open.startKm + " كم", "📸 Send odometer photo (end).\nStart: " + open.startKm + " km")); return;
  }

  // Stats
  if (text === "📊 إحصائياتي" || text === "📊 My Stats") {
    const today = new Date().toISOString().split("T")[0];
    const myShifts = data.shifts.filter(function(s) { return s.driverId === userId && s.totalKm; });
    const todayShift = myShifts.find(function(s) { return s.date === today; });
    const myInv = data.invoices.filter(function(i) { return i.driverId === userId && i.approved; });
    const totalKm = myShifts.reduce(function(s, x) { return s + x.totalKm; }, 0);
    const totalRev = myInv.reduce(function(s, i) { return s + (i.amount || 0); }, 0);
    if (lang === "ar") {
      await sendMsg(chatId, "📊 إحصائياتي\n\n🚗 كيلومترات اليوم: " + (todayShift ? todayShift.totalKm.toFixed(1) : 0) + " كم\n📏 إجمالي الكيلومترات: " + totalKm.toFixed(1) + " كم\n🔄 عدد الورديات: " + myShifts.length + "\n💰 الفواتير المقبولة: " + myInv.length + "\n💵 إجمالي الإيرادات: " + totalRev.toFixed(3) + " د.ك", menu(userId));
    } else {
      await sendMsg(chatId, "📊 My Stats\n\n🚗 Today KM: " + (todayShift ? todayShift.totalKm.toFixed(1) : 0) + " km\n📏 Total KM: " + totalKm.toFixed(1) + " km\n🔄 Shifts: " + myShifts.length + "\n💰 Approved Invoices: " + myInv.length + "\n💵 Total Revenue: " + totalRev.toFixed(3) + " KWD", menu(userId));
    }
    return;
  }

  // Handle photos
  if (photo) {
    const state = userStates[userId] || "invoice";
    const isEnglish = state === "invoice_en";
    const effectiveState = state === "invoice_en" ? "invoice" : state;
    delete userStates[userId];
    const url = await getFileUrl(photo[photo.length - 1].file_id);
    if (!url) { await sendMsg(chatId, t(userId, "❌ لم أتمكن من استلام الصورة.", "❌ Could not receive image.")); return; }
    await sendMsg(chatId, t(userId, "⏳ جاري تحليل الصورة...", "⏳ Analyzing image..."));

    if (state === "invoice" || state === "invoice_en") {
      const res = await analyzeImage(url, "This is a receipt/invoice image. Find the TOTAL amount paid. Return ONLY valid JSON: {\"amount\": 7.000, \"desc\": \"store name or items\"} - Use the exact number from Total/Grand Total/Amount Due field.");
      if (!res.amount || res.error) {
        await sendMsg(chatId, t(userId, "❌ لم أتمكن من قراءة المبلغ. جرب صورة أوضح أو اكتب المبلغ يدوياً.", "❌ Could not read amount. Try a clearer photo or type the amount manually."));
        return;
      }
      const inv = { id: Date.now(), driverId: userId, driverName: driver ? driver.name : firstName, chatId: parseInt(userId), amount: res.amount, desc: res.desc || "فاتورة", imageUrl: url, date: new Date().toISOString(), approved: false, pending: true, rejected: false };
      data.invoices.push(inv);
      saveData(data);
      await sendMsg(chatId, t(userId, "✅ تم استلام الفاتورة!\n💰 المبلغ: " + Number(res.amount).toFixed(3) + " د.ك\n📝 " + res.desc + "\n\n⏳ في انتظار موافقة المشرف.", "✅ Invoice received!\n💰 Amount: " + Number(res.amount).toFixed(3) + " KWD\n📝 " + res.desc + "\n\n⏳ Waiting for approval."), menu(userId));
      if (OWNER_ID) {
        await sendInline(OWNER_ID,
          "📨 فاتورة جديدة\n👤 " + (driver ? driver.name : firstName) + "\n💰 " + Number(res.amount).toFixed(3) + " د.ك\n📝 " + res.desc,
          [[{ text: "✅ قبول", callback_data: "app_" + inv.id }, { text: "❌ رفض", callback_data: "rej_" + inv.id }]]
        );
      }
    } else {
      const res = await analyzeImage(url, "This is a vehicle odometer/mileage reading. Return ONLY valid JSON: {\"km\": 12345} - The number shown on the odometer in kilometers.");
      if (!res.km || res.error) {
        await sendMsg(chatId, t(userId, "❌ لم أتمكن من قراءة العداد. جرب صورة أوضح.", "❌ Could not read odometer. Try a clearer photo."));
        return;
      }
      const km = parseFloat(res.km);
      const today = new Date().toISOString().split("T")[0];
      if (state === "start_km") {
        const shift = { id: Date.now(), driverId: userId, driverName: driver ? driver.name : firstName, date: today, startKm: km, endKm: null, totalKm: null, startTime: new Date().toISOString(), endTime: null, startImgUrl: url };
        data.shifts.push(shift);
        saveData(data);
        await sendMsg(chatId, t(userId, "✅ بدأت الوردية!\n🚗 العداد: " + km + " كم", "✅ Shift started!\n🚗 Odometer: " + km + " km"), menu(userId));
        if (OWNER_ID) await sendMsg(OWNER_ID, "🟢 " + (driver ? driver.name : firstName) + " بدأ وردية | " + km + " كم");
      } else {
        const open = data.shifts.find(function(s) { return s.driverId === userId && s.date === today && !s.endKm; });
        if (!open) { await sendMsg(chatId, t(userId, "⚠️ لا توجد وردية مفتوحة.", "⚠️ No open shift.")); return; }
        const total = km - open.startKm;
        open.endKm = km; open.totalKm = total; open.endTime = new Date().toISOString(); open.endImgUrl = url;
        saveData(data);
        await sendMsg(chatId, t(userId, "🏁 انتهت الوردية!\n📏 من " + open.startKm + " إلى " + km + " كم\n✅ الإجمالي: " + total.toFixed(1) + " كم", "🏁 Shift ended!\n📏 From " + open.startKm + " to " + km + " km\n✅ Total: " + total.toFixed(1) + " km"), menu(userId));
        if (OWNER_ID) await sendMsg(OWNER_ID, "🏁 " + (driver ? driver.name : firstName) + " أنهى وردية | " + total.toFixed(1) + " كم");
      }
    }
    return;
  }

  await sendMsg(chatId, t(userId, "اختر من القائمة 👇", "Choose from menu 👇"), menu(userId));
}

// HTTP Server + API
http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") { res.writeHead(200); res.end("RASEEDAK Bot 🚀"); return; }
  if (url.pathname === "/api/invoices") {
    const d = loadData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, invoices: d.invoices.filter(function(i) { return i.pending; }) }));
    return;
  }
  if (url.pathname === "/api/data") {
    const d = loadData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, shifts: d.shifts, invoices: d.invoices, drivers: d.drivers }));
    return;
  }
  if (url.pathname === "/api/approve") {
    const id = parseInt(url.searchParams.get("id"));
    const d = loadData();
    const inv = d.invoices.find(function(i) { return i.id === id; });
    if (inv) { inv.approved = true; inv.pending = false; inv.approvedAt = new Date().toISOString(); saveData(d); if (inv.chatId) sendMsg(inv.chatId, "✅ تمت الموافقة على فاتورتك\n💰 " + Number(inv.amount).toFixed(3) + " د.ك"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: !!inv }));
    return;
  }
  if (url.pathname === "/api/reject") {
    const id = parseInt(url.searchParams.get("id"));
    const d = loadData();
    const inv = d.invoices.find(function(i) { return i.id === id; });
    if (inv) { inv.approved = false; inv.pending = false; inv.rejected = true; saveData(d); if (inv.chatId) sendMsg(inv.chatId, "❌ تم رفض فاتورتك."); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: !!inv }));
    return;
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, function() { console.log("Server on port " + PORT); });

// Polling with deduplication
let lastOffset = 0;
let isPolling = false;

async function poll() {
  if (isPolling) { setTimeout(poll, 2000); return; }
  isPolling = true;
  try {
    const r = await tgReq("getUpdates", { offset: lastOffset, timeout: 20 });
    if (r.ok && r.result && r.result.length > 0) {
      for (let i = 0; i < r.result.length; i++) {
        const u = r.result[i];
        lastOffset = u.update_id + 1;
        try { await handleUpdate(u); } catch(e) { console.error("Error:", e.message); }
      }
    }
  } catch(e) { console.error("Poll error:", e.message); }
  isPolling = false;
  setTimeout(poll, 1500);
}

console.log("🤖 RASEEDAK Bot starting...");
// Skip old pending messages
tgReq("getUpdates", { offset: -1, timeout: 1 }).then(function(r) {
  if (r.ok && r.result && r.result.length > 0) {
    lastOffset = r.result[r.result.length - 1].update_id + 1;
    console.log("Starting from offset:", lastOffset);
  }
  poll();
}).catch(function() { poll(); });
