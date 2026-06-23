const https = require("https");
const http = require("http");
const fs = require("fs");

// ── CONFIG ──────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN || "";
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "raseedak2024";

// ── DATA STORE ───────────────────────────────────────────
const DATA_FILE = "./data.json";
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch(e) { return { drivers: {}, shifts: [], invoices: [] }; }
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch(e) {}
}

// ── TELEGRAM ─────────────────────────────────────────────
function tgReq(method, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TG_TOKEN}/${method}`,
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
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  return tgReq("sendMessage", body);
}

function sendInline(chatId, text, inline_keyboard) {
  return tgReq("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: { inline_keyboard } });
}

function getFileUrl(fileId) {
  return tgReq("getFile", { file_id: fileId }).then(r =>
    r.ok ? `https://api.telegram.org/file/bot${TG_TOKEN}/${r.result.file_path}` : null
  );
}

// ── CLAUDE VISION ─────────────────────────────────────────
function analyzeImage(imageUrl, prompt) {
  return new Promise((resolve) => {
    const cleanKey = (CLAUDE_KEY || "").trim().replace(/[\r\n\t]/g, "");
    if (!cleanKey) return resolve({ error: "No API key" });
    https.get(imageUrl, (imgRes) => {
      const chunks = [];
      imgRes.on("data", c => chunks.push(c));
      imgRes.on("end", () => {
        const b64 = Buffer.concat(chunks).toString("base64");
        const mediaType = imgRes.headers["content-type"] || "image/jpeg";
        const body = JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 500,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: prompt }
          ]}]
        });
        const opts = {
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
            "x-api-key": cleanKey, "anthropic-version": "2023-06-01" }
        };
        const req = https.request(opts, (res) => {
          let raw = "";
          res.on("data", c => raw += c);
          res.on("end", () => {
            try {
              const d = JSON.parse(raw);
              const txt = d.content && d.content[0] ? d.content[0].text : "";
              const cleaned = txt.replace(/```[\w]*/g, "").trim();
              // Find JSON object in response
              const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
              if (jsonMatch) {
                try { resolve(JSON.parse(jsonMatch[0])); }
                catch(pe) { resolve({error: "parse error: "+pe.message}); }
              } else resolve({error: "no JSON found in: "+cleaned.slice(0,100)});
            } catch(e) { resolve({ error: e.message }); }
          });
        });
        req.on("error", e => resolve({ error: e.message }));
        req.write(body); req.end();
      });
    }).on("error", e => resolve({ error: e.message }));
  });
}

const MENU = [["📋 إرسال فاتورة", "🚗 بداية الوردية"], ["🏁 نهاية الوردية", "📊 إحصائياتي"]];
const userStates = {};

// ── BOT LOGIC ─────────────────────────────────────────────
async function handleUpdate(update) {
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

  // Callback: register driver
  if (cb && text.startsWith("reg_")) {
    const parts = text.split("_");
    const newId = parts[1];
    const newName = parts.slice(2).join("_");
    data.drivers[newId] = { name: newName, chatId: parseInt(newId), registeredAt: new Date().toISOString() };
    saveData(data);
    await tgReq("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ تم التسجيل!" });
    await sendMsg(chatId, `✅ تم تسجيل السائق <b>${newName}</b>`);
    await sendMsg(parseInt(newId), `🎉 <b>تم تسجيلك بنجاح!</b>\n\nمرحباً ${newName}! اكتب /start للبدء.`, MENU);
    return;
  }

  // Callback: approve/reject invoice
  if (cb && (text.startsWith("app_") || text.startsWith("rej_"))) {
    const [action, invoiceId] = text.split("_");
    const inv = data.invoices.find(i => i.id === parseInt(invoiceId));
    if (!inv) { await tgReq("answerCallbackQuery", { callback_query_id: cb.id }); return; }
    if (action === "app") {
      inv.approved = true; inv.pending = false; inv.approvedAt = new Date().toISOString();
      saveData(data);
      await tgReq("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ تمت الموافقة!" });
      await sendMsg(parseInt(inv.driverId), `✅ <b>تمت الموافقة على فاتورتك</b>\n💰 ${Number(inv.amount).toFixed(3)} د.ك`, MENU);
      await sendMsg(chatId, `✅ تمت الموافقة على فاتورة ${inv.driverName}`);
    } else {
      inv.approved = false; inv.pending = false; inv.rejected = true;
      saveData(data);
      await tgReq("answerCallbackQuery", { callback_query_id: cb.id, text: "❌ تم الرفض" });
      await sendMsg(parseInt(inv.driverId), `❌ <b>تم رفض فاتورتك</b>\nتواصل مع المشرف.`, MENU);
      await sendMsg(chatId, `❌ تم رفض فاتورة ${inv.driverName}`);
    }
    return;
  }

  // Unregistered
  if (!driver && !isOwner) {
    await sendMsg(chatId,
      `🔒 <b>حسابك غير مسجل</b>\n\nأرسل هذه المعلومات لمشرفك:\n\n👤 الاسم: ${firstName}\n🆔 Telegram ID: <code>${userId}</code>`
    );
    if (OWNER_ID) {
      await sendInline(OWNER_ID,
        `📬 <b>طلب تسجيل</b>\n👤 ${firstName}\n🆔 ID: <code>${userId}</code>`,
        [[{ text: "✅ تسجيل", callback_data: `reg_${userId}_${firstName}` }]]
      );
    }
    return;
  }

  // /start
  if (text === "/start") {
    await sendMsg(chatId, `👋 <b>مرحباً ${driver ? driver.name : firstName}!</b>\n\nاختر من القائمة:`, MENU);
    return;
  }

  if (text === "📋 إرسال فاتورة") { userStates[userId] = "invoice"; await sendMsg(chatId, "📸 أرسل صورة الفاتورة."); return; }
  if (text === "🚗 بداية الوردية") {
    const today = new Date().toISOString().split("T")[0];
    if (data.shifts.find(s => s.driverId === userId && s.date === today && !s.endKm)) {
      await sendMsg(chatId, "⚠️ عندك وردية مفتوحة اليوم. أنهها أولاً."); return;
    }
    userStates[userId] = "start_km";
    await sendMsg(chatId, "📸 أرسل صورة عداد السيارة (بداية الوردية)."); return;
  }
  if (text === "🏁 نهاية الوردية") {
    const today = new Date().toISOString().split("T")[0];
    const open = data.shifts.find(s => s.driverId === userId && s.date === today && !s.endKm);
    if (!open) { await sendMsg(chatId, "⚠️ لا توجد وردية مفتوحة. ابدأ وردية أولاً."); return; }
    userStates[userId] = "end_km";
    await sendMsg(chatId, `📸 أرسل صورة عداد السيارة (نهاية الوردية).\n\nبداية: ${open.startKm} كم`); return;
  }
  if (text === "📊 إحصائياتي") {
    const today = new Date().toISOString().split("T")[0];
    const myShifts = data.shifts.filter(s => s.driverId === userId && s.totalKm);
    const todayKm = data.shifts.find(s => s.driverId === userId && s.date === today && s.totalKm);
    const myInv = data.invoices.filter(i => i.driverId === userId && i.approved);
    await sendMsg(chatId,
      `📊 <b>إحصائياتي</b>\n\n🚗 كيلومترات اليوم: ${todayKm ? todayKm.totalKm.toFixed(1) : 0} كم\n📏 إجمالي الكيلومترات: ${myShifts.reduce((s,x)=>s+x.totalKm,0).toFixed(1)} كم\n🔄 عدد الورديات: ${myShifts.length}\n💰 الفواتير المقبولة: ${myInv.length}\n💵 إجمالي الإيرادات: ${myInv.reduce((s,i)=>s+(i.amount||0),0).toFixed(3)} د.ك`,
      MENU
    );
    return;
  }

  // Photos
  if (photo) {
    const state = userStates[userId] || "invoice";
    const url = await getFileUrl(photo[photo.length-1].file_id);
    if (!url) { await sendMsg(chatId, "❌ لم أتمكن من استلام الصورة."); return; }
    await sendMsg(chatId, "⏳ جاري معالجة الصورة بالذكاء الاصطناعي...");

    if (state === "invoice") {
      const res = await analyzeImage(url, "Look at this receipt/invoice. Find the total amount. Reply with ONLY this JSON, nothing else: {\"amount\": NUMBER, \"desc\": \"SHORT_DESCRIPTION\"} - Example: {\"amount\": 7.000, \"desc\": \"Crops Coffee\"}");
      if (!res.amount) { await sendMsg(chatId, "❌ لم أتمكن من قراءة المبلغ. جرب صورة أوضح."); return; }
      const inv = { id: Date.now(), driverId: userId, driverName: driver ? driver.name : firstName, chatId: parseInt(userId), amount: res.amount, desc: res.desc || "فاتورة", imageUrl: url, date: new Date().toISOString(), approved: false, pending: true, rejected: false };
      data.invoices.push(inv);
      saveData(data);
      await sendMsg(chatId, `✅ <b>تم استلام الفاتورة!</b>\n💰 المبلغ: ${Number(res.amount).toFixed(3)} د.ك\n📝 ${res.desc}\n\n⏳ في انتظار موافقة المشرف.`, MENU);
      if (OWNER_ID) {
        await sendInline(OWNER_ID,
          `📨 <b>فاتورة جديدة</b>\n👤 ${driver ? driver.name : firstName}\n💰 ${Number(res.amount).toFixed(3)} د.ك\n📝 ${res.desc}`,
          [[{ text: "✅ قبول", callback_data: `app_${inv.id}` }, { text: "❌ رفض", callback_data: `rej_${inv.id}` }]]
        );
      }
    } else {
      const res = await analyzeImage(url, "هذه صورة عداد كيلومترات سيارة. أرجع JSON فقط: {\"km\": رقم}");
      if (!res.km) { await sendMsg(chatId, "❌ لم أتمكن من قراءة العداد. جرب صورة أوضح للأرقام."); return; }
      const km = parseFloat(res.km);
      const today = new Date().toISOString().split("T")[0];
      if (state === "start_km") {
        const shift = { id: Date.now(), driverId: userId, driverName: driver ? driver.name : firstName, date: today, startKm: km, endKm: null, totalKm: null, startTime: new Date().toISOString(), endTime: null, startImgUrl: url };
        data.shifts.push(shift);
        saveData(data);
        await sendMsg(chatId, `✅ <b>بدأت الوردية!</b>\n🚗 العداد: ${km} كم\n\nأرسل صورة العداد عند الانتهاء.`, MENU);
        if (OWNER_ID) await sendMsg(OWNER_ID, `🟢 ${driver ? driver.name : firstName} بدأ وردية | ${km} كم`);
      } else {
        const open = data.shifts.find(s => s.driverId === userId && s.date === today && !s.endKm);
        if (!open) { await sendMsg(chatId, "⚠️ لا توجد وردية مفتوحة."); return; }
        const total = km - open.startKm;
        open.endKm = km; open.totalKm = total; open.endTime = new Date().toISOString(); open.endImgUrl = url;
        saveData(data);
        await sendMsg(chatId, `🏁 <b>انتهت الوردية!</b>\n📏 من ${open.startKm} إلى ${km} كم\n✅ <b>إجمالي: ${total.toFixed(1)} كم</b>`, MENU);
        if (OWNER_ID) await sendMsg(OWNER_ID, `🏁 ${driver ? driver.name : firstName} أنهى وردية | ${total.toFixed(1)} كم`);
      }
    }
    delete userStates[userId];
    return;
  }

  await sendMsg(chatId, "اختر من القائمة 👇", MENU);
}

// ── HTTP SERVER + API ─────────────────────────────────────
http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);
  const secret = url.searchParams.get("secret");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("RASEEDAK Bot is running! 🚀");
    return;
  }

  // API: get pending invoices
  if (req.method === "GET" && url.pathname === "/api/invoices") {
    const data = loadData();
    const pending = data.invoices.filter(i => i.pending);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, invoices: pending }));
    return;
  }

  // API: get all data for the app
  if (req.method === "GET" && url.pathname === "/api/data") {
    const data = loadData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, shifts: data.shifts, invoices: data.invoices, drivers: data.drivers }));
    return;
  }

  // API: approve invoice
  if (req.method === "GET" && url.pathname === "/api/approve") {
    const id = parseInt(url.searchParams.get("id"));
    const data = loadData();
    const inv = data.invoices.find(i => i.id === id);
    if (inv) {
      inv.approved = true; inv.pending = false; inv.approvedAt = new Date().toISOString();
      saveData(data);
      if (inv.chatId) sendMsg(inv.chatId, `✅ تمت الموافقة على فاتورتك\n💰 ${Number(inv.amount).toFixed(3)} د.ك`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: !!inv }));
    return;
  }

  // API: reject invoice
  if (req.method === "GET" && url.pathname === "/api/reject") {
    const id = parseInt(url.searchParams.get("id"));
    const data = loadData();
    const inv = data.invoices.find(i => i.id === id);
    if (inv) {
      inv.approved = false; inv.pending = false; inv.rejected = true;
      saveData(data);
      if (inv.chatId) sendMsg(inv.chatId, "❌ تم رفض فاتورتك. تواصل مع المشرف.");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: !!inv }));
    return;
  }

  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log(`Server on port ${PORT}`));

// ── POLLING ───────────────────────────────────────────────
let lastOffset = 0;
let isPolling = false;
async function poll() {
  if (isPolling) { setTimeout(poll, 2000); return; }
  isPolling = true;
  try {
    const r = await tgReq("getUpdates", { offset: lastOffset, timeout: 20 });
    if (r.ok && r.result && r.result.length > 0) {
      for (const u of r.result) {
        try { await handleUpdate(u); } catch(e) { console.error("Handle error:", e.message); }
        lastOffset = u.update_id + 1;
      }
    }
  } catch(e) { console.error("Poll error:", e.message); }
  isPolling = false;
  setTimeout(poll, 1500);
}

console.log("🤖 RASEEDAK Bot starting...");
// Skip all pending old messages on startup
tgReq("getUpdates", { offset: -1, timeout: 1 }).then(r => {
  if (r.ok && r.result && r.result.length > 0) {
    lastOffset = r.result[r.result.length - 1].update_id + 1;
    console.log("Skipped old messages, starting from offset:", lastOffset);
  }
  poll();
}).catch(() => poll());
