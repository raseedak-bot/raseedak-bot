const https = require("https");

// ── CONFIG ──────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN || "8630169192:AAE85CiYVxoRCxf5SO-rmVbo59RiMsNzOdY";
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";
const OWNER_ID = parseInt(process.env.OWNER_ID || "1495806056");
const PORT = process.env.PORT || 3000;

// ── SIMPLE IN-MEMORY STORE (replace with DB later) ──────
// In production use a real DB. For now JSON file.
const fs = require("fs");
const DATA_FILE = "./data.json";

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch(e) { return { drivers: {}, shifts: [], invoices: [] }; }
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ── TELEGRAM HELPERS ────────────────────────────────────
function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TG_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMsg(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: false };
  return tgRequest("sendMessage", body);
}

function sendInlineMsg(chatId, text, inline_keyboard) {
  return tgRequest("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: { inline_keyboard }
  });
}

function getFileUrl(fileId) {
  return tgRequest("getFile", { file_id: fileId }).then(r => {
    if (r.ok) return `https://api.telegram.org/file/bot${TG_TOKEN}/${r.result.file_path}`;
    return null;
  });
}

// ── CLAUDE VISION ────────────────────────────────────────
function analyzeImage(imageUrl, prompt) {
  return new Promise((resolve) => {
    if (!CLAUDE_KEY) return resolve({ error: "No API key" });
    https.get(imageUrl, (imgRes) => {
      const chunks = [];
      imgRes.on("data", c => chunks.push(c));
      imgRes.on("end", () => {
        const b64 = Buffer.concat(chunks).toString("base64");
        const mediaType = imgRes.headers["content-type"] || "image/jpeg";
        const body = JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 500,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: prompt }
          ]}]
        });
        const options = {
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "x-api-key": CLAUDE_KEY,
            "anthropic-version": "2023-06-01"
          }
        };
        const req = https.request(options, (res) => {
          let raw = "";
          res.on("data", c => raw += c);
          res.on("end", () => {
            try {
              const d = JSON.parse(raw);
              const txt = d.content && d.content[0] ? d.content[0].text : "";
              const clean = txt.replace(/```[\w]*/g, "").trim();
              resolve(JSON.parse(clean));
            } catch(e) { resolve({ error: e.message }); }
          });
        });
        req.on("error", e => resolve({ error: e.message }));
        req.write(body);
        req.end();
      });
    }).on("error", e => resolve({ error: e.message }));
  });
}

// ── MAIN MENU KEYBOARD ───────────────────────────────────
const MAIN_MENU = [
  ["📋 إرسال فاتورة", "🚗 بداية الوردية"],
  ["🏁 نهاية الوردية", "📊 إحصائياتي"]
];

// ── STATES ───────────────────────────────────────────────
const userStates = {};

// ── PROCESS UPDATE ───────────────────────────────────────
async function processUpdate(update) {
  const msg = update.message || update.callback_query?.message;
  if (!msg) return;

  const chatId = update.callback_query ? update.callback_query.message.chat.id : msg.chat.id;
  const userId = update.callback_query ? update.callback_query.from.id : msg.from.id;
  const firstName = update.callback_query ? update.callback_query.from.first_name : msg.from.first_name;
  const text = update.callback_query ? update.callback_query.data : (msg.text || "");
  const photo = msg.photo;

  const data = loadData();
  const driverKey = String(userId);
  const driver = data.drivers[driverKey];

  // ── غير مسجل ─────────────────────────────────────────
  if (!driver && userId !== OWNER_ID) {
    await sendMsg(chatId,
      `🔒 <b>حسابك غير مسجل بعد</b>\n\n` +
      `لتسجيلك، أرسل معلوماتك لمشرفك:\n\n` +
      `👤 <b>الاسم:</b> ${firstName}\n` +
      `🆔 <b>Telegram ID:</b> <code>${userId}</code>\n` +
      `💬 <b>Chat ID:</b> <code>${chatId}</code>\n\n` +
      `سيضيفك المشرف في النظام ثم يمكنك البدء.`
    );
    // Notify owner
    if (OWNER_ID) {
      await sendInlineMsg(OWNER_ID,
        `📬 <b>طلب تسجيل جديد</b>\n\n👤 ${firstName}\n🆔 ID: <code>${userId}</code>`,
        [[{ text: "✅ تسجيل هذا السائق", callback_data: `register_${userId}_${firstName}` }]]
      );
    }
    return;
  }

  // ── المالك يسجل سائق ─────────────────────────────────
  if (update.callback_query && text.startsWith("register_")) {
    const [, newId, ...nameParts] = text.split("_");
    const newName = nameParts.join(" ");
    data.drivers[newId] = { name: newName, chatId: parseInt(newId), registeredAt: new Date().toISOString() };
    saveData(data);
    await tgRequest("answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "✅ تم التسجيل!" });
    await sendMsg(chatId, `✅ تم تسجيل السائق <b>${newName}</b>`);
    await sendMsg(parseInt(newId),
      `🎉 <b>تم تسجيلك بنجاح!</b>\n\nمرحباً ${newName}، يمكنك الآن استخدام البوت.\n\nاضغط /start للبدء.`,
      MAIN_MENU
    );
    return;
  }

  // ── /start ────────────────────────────────────────────
  if (text === "/start") {
    const name = driver ? driver.name : firstName;
    await sendMsg(chatId,
      `👋 <b>مرحباً ${name}!</b>\n\nاختر من القائمة:`,
      MAIN_MENU
    );
    return;
  }

  // ── إرسال فاتورة ─────────────────────────────────────
  if (text === "📋 إرسال فاتورة") {
    userStates[userId] = "waiting_invoice";
    await sendMsg(chatId, "📸 أرسل صورة الفاتورة وسيتم معالجتها تلقائياً.");
    return;
  }

  // ── بداية الوردية ─────────────────────────────────────
  if (text === "🚗 بداية الوردية") {
    const today = new Date().toISOString().split("T")[0];
    const openShift = data.shifts.find(s => s.driverId === driverKey && s.date === today && !s.endKm);
    if (openShift) {
      await sendMsg(chatId, `⚠️ عندك وردية مفتوحة اليوم بدأت بعداد ${openShift.startKm} كم.\n\nأرسل صورة عداد النهاية لإنهائها.`);
      return;
    }
    userStates[userId] = "waiting_start_km";
    await sendMsg(chatId, "📸 أرسل صورة عداد السيارة (قراءة البداية).");
    return;
  }

  // ── نهاية الوردية ─────────────────────────────────────
  if (text === "🏁 نهاية الوردية") {
    const today = new Date().toISOString().split("T")[0];
    const openShift = data.shifts.find(s => s.driverId === driverKey && s.date === today && !s.endKm);
    if (!openShift) {
      await sendMsg(chatId, "⚠️ لا توجد وردية مفتوحة اليوم. ابدأ وردية أولاً.");
      return;
    }
    userStates[userId] = "waiting_end_km";
    await sendMsg(chatId, `📸 أرسل صورة عداد السيارة (قراءة النهاية).\n\nقراءة البداية: ${openShift.startKm} كم`);
    return;
  }

  // ── إحصائياتي ─────────────────────────────────────────
  if (text === "📊 إحصائياتي") {
    const today = new Date().toISOString().split("T")[0];
    const myShifts = data.shifts.filter(s => s.driverId === driverKey);
    const todayShift = myShifts.find(s => s.date === today && s.totalKm);
    const totalKm = myShifts.filter(s => s.totalKm).reduce((sum, s) => sum + s.totalKm, 0);
    const myInvoices = data.invoices.filter(i => i.driverId === driverKey && i.approved);
    const totalRevenue = myInvoices.reduce((sum, i) => sum + (i.amount || 0), 0);

    await sendMsg(chatId,
      `📊 <b>إحصائياتي</b>\n\n` +
      `🚗 <b>كيلومترات اليوم:</b> ${todayShift ? todayShift.totalKm.toFixed(1) : 0} كم\n` +
      `📏 <b>إجمالي الكيلومترات:</b> ${totalKm.toFixed(1)} كم\n` +
      `🔄 <b>عدد الورديات:</b> ${myShifts.filter(s => s.totalKm).length}\n` +
      `💰 <b>الفواتير المقبولة:</b> ${myInvoices.length}\n` +
      `💵 <b>إجمالي الإيرادات:</b> ${totalRevenue.toFixed(3)} د.ك`,
      MAIN_MENU
    );
    return;
  }

  // ── معالجة الصور ─────────────────────────────────────
  if (photo) {
    const state = userStates[userId] || "waiting_invoice";
    const bestPhoto = photo[photo.length - 1];
    const imageUrl = await getFileUrl(bestPhoto.file_id);
    if (!imageUrl) { await sendMsg(chatId, "❌ لم أتمكن من استلام الصورة."); return; }

    await sendMsg(chatId, "⏳ جاري معالجة الصورة...");

    if (state === "waiting_invoice") {
      const res = await analyzeImage(imageUrl,
        "هذه فاتورة. أرجع JSON فقط: {\"amount\": رقم, \"desc\": \"وصف\", \"items\": [\"بند1\",\"بند2\"]}"
      );
      if (res.error || !res.amount) {
        await sendMsg(chatId, "❌ لم أتمكن من قراءة المبلغ. تأكد أن الصورة واضحة.");
        return;
      }
      // Save pending invoice
      const invoice = {
        id: Date.now(),
        driverId: driverKey,
        driverName: driver ? driver.name : firstName,
        amount: res.amount,
        desc: res.desc || "فاتورة",
        imageUrl,
        date: new Date().toISOString(),
        approved: false,
        pending: true
      };
      data.invoices.push(invoice);
      saveData(data);

      await sendMsg(chatId,
        `✅ <b>تم استلام الفاتورة!</b>\n\n💰 المبلغ: <b>${res.amount.toFixed(3)} د.ك</b>\n📝 الوصف: ${res.desc}\n\nفي انتظار موافقة المشرف.`,
        MAIN_MENU
      );
      // Notify owner
      if (OWNER_ID) {
        await sendInlineMsg(OWNER_ID,
          `📨 <b>فاتورة جديدة</b>\n\n👤 السائق: ${driver ? driver.name : firstName}\n💰 المبلغ: ${res.amount.toFixed(3)} د.ك\n📝 ${res.desc}`,
          [[
            { text: "✅ قبول", callback_data: `approve_${invoice.id}` },
            { text: "❌ رفض", callback_data: `reject_${invoice.id}` }
          ]]
        );
      }

    } else if (state === "waiting_start_km" || state === "waiting_end_km") {
      const res = await analyzeImage(imageUrl,
        "هذه صورة عداد كيلومترات سيارة. أرجع JSON فقط: {\"km\": رقم_العداد_بالكيلومتر}"
      );
      if (res.error || !res.km) {
        await sendMsg(chatId, "❌ لم أتمكن من قراءة العداد. تأكد أن الصورة واضحة وتظهر الأرقام.");
        return;
      }
      const km = parseFloat(res.km);
      const today = new Date().toISOString().split("T")[0];

      if (state === "waiting_start_km") {
        const shift = { id: Date.now(), driverId: driverKey, driverName: driver ? driver.name : firstName, date: today, startKm: km, endKm: null, totalKm: null, startTime: new Date().toISOString(), endTime: null, startImgUrl: imageUrl };
        data.shifts.push(shift);
        saveData(data);
        await sendMsg(chatId,
          `✅ <b>بدأت الوردية!</b>\n\n🚗 قراءة العداد: <b>${km} كم</b>\n🕐 وقت البداية: ${new Date().toLocaleTimeString("ar-KW")}\n\nعند انتهاء يومك اضغط "🏁 نهاية الوردية"`,
          MAIN_MENU
        );
        if (OWNER_ID) await sendMsg(OWNER_ID, `🟢 ${driver ? driver.name : firstName} بدأ وردية | عداد: ${km} كم`);

      } else {
        const openShift = data.shifts.find(s => s.driverId === driverKey && s.date === today && !s.endKm);
        if (!openShift) { await sendMsg(chatId, "⚠️ لا توجد وردية مفتوحة."); return; }
        const totalKm = km - openShift.startKm;
        openShift.endKm = km;
        openShift.totalKm = totalKm;
        openShift.endTime = new Date().toISOString();
        openShift.endImgUrl = imageUrl;
        saveData(data);
        await sendMsg(chatId,
          `🏁 <b>انتهت الوردية!</b>\n\n📏 بداية: ${openShift.startKm} كم\n📏 نهاية: ${km} كم\n✅ <b>إجمالي: ${totalKm.toFixed(1)} كم</b>\n\nأحسنت! إلى اللقاء غداً.`,
          MAIN_MENU
        );
        if (OWNER_ID) await sendMsg(OWNER_ID, `🏁 ${driver ? driver.name : firstName} أنهى وردية | ${totalKm.toFixed(1)} كم`);
      }
      delete userStates[userId];
    }
    return;
  }

  // ── موافقة/رفض فاتورة ────────────────────────────────
  if (update.callback_query && (text.startsWith("approve_") || text.startsWith("reject_"))) {
    const [action, invoiceId] = text.split("_");
    const invoice = data.invoices.find(i => i.id === parseInt(invoiceId));
    if (!invoice) { await tgRequest("answerCallbackQuery", { callback_query_id: update.callback_query.id }); return; }

    if (action === "approve") {
      invoice.approved = true; invoice.pending = false;
      saveData(data);
      await tgRequest("answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "✅ تم القبول!" });
      await sendMsg(invoice.driverId, `✅ <b>تمت الموافقة على فاتورتك</b>\n💰 ${invoice.amount.toFixed(3)} د.ك\n📝 ${invoice.desc}`, MAIN_MENU);
      await sendMsg(chatId, `✅ تمت الموافقة على فاتورة ${invoice.driverName} (${invoice.amount.toFixed(3)} د.ك)`);
    } else {
      invoice.approved = false; invoice.pending = false; invoice.rejected = true;
      saveData(data);
      await tgRequest("answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "❌ تم الرفض" });
      await sendMsg(invoice.driverId, `❌ <b>تم رفض فاتورتك</b>\nتواصل مع المشرف لمزيد من التفاصيل.`, MAIN_MENU);
      await sendMsg(chatId, `❌ تم رفض فاتورة ${invoice.driverName}`);
    }
    return;
  }

  // Default
  await sendMsg(chatId, "اختر من القائمة 👇", MAIN_MENU);
}

// ── POLLING ──────────────────────────────────────────────
let lastOffset = 0;
async function poll() {
  try {
    const res = await tgRequest("getUpdates", { offset: lastOffset, timeout: 30 });
    if (res.ok && res.result.length > 0) {
      for (const update of res.result) {
        await processUpdate(update);
        lastOffset = update.update_id + 1;
      }
    }
  } catch(e) { console.error("Poll error:", e.message); }
  setTimeout(poll, 1000);
}

// ── HTTP SERVER (for Railway health check) ───────────────
const http = require("http");
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("RASEEDAK Bot is running! 🚀");
}).listen(PORT, () => console.log(`Server on port ${PORT}`));

console.log("🤖 RASEEDAK Bot starting...");
poll();
