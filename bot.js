require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di file .env!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = {};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER KEYBOARD
// ─────────────────────────────────────────────────────────────────────────────
function showPattern(colors) {
  return colors.map(c => c === 'green' ? '🟢' : '🔴').join('');
}

function buildCandleKeyboard(current, total) {
  return {
    inline_keyboard: [
      [
        { text: '🟢 GREEN', callback_data: 'candle_green' },
        { text: '🔴 RED',   callback_data: 'candle_red'   },
      ],
      [
        { text: '↩️ Hapus Terakhir', callback_data: 'candle_undo' },
        { text: `✅ Selesai (${current}/${total})`, callback_data: 'candle_done' },
      ],
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNGSI UTAMA
// ─────────────────────────────────────────────────────────────────────────────
async function getForecast(colors, forecastLength) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    await page.goto('https://vebtiq.com/flexible-pattern/forecast', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 1000));

    const patternLength = colors.length;
    const colorString = colors.join('-');

    // ── Pilih Pattern Length ──
    await page.evaluate((pLen) => {
      const sel = document.querySelectorAll('select')[0];
      if (!sel) return;
      for (const opt of sel.options) {
        if (opt.value == pLen || opt.text.trim().startsWith(String(pLen))) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, patternLength);

    await new Promise(r => setTimeout(r, 800));

    // ── Pilih Forecast Length ──
    await page.evaluate((fLen) => {
      const sel = document.querySelectorAll('select')[1];
      if (!sel) return;
      for (const opt of sel.options) {
        if (opt.value == fLen || opt.text.trim().startsWith(String(fLen))) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, forecastLength);

    await new Promise(r => setTimeout(r, 500));

    // ── Isi textarea warna candle ──
    await page.evaluate((colorStr) => {
      const textarea = document.querySelector('textarea');
      if (textarea) {
        textarea.value = colorStr;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, colorString);

    await new Promise(r => setTimeout(r, 500));

    // ── Pasang listener untuk tab baru SEBELUM klik tombol ──
    const newPagePromise = new Promise(resolve => {
      browser.once('targetcreated', async (target) => {
        const newPage = await target.page();
        resolve(newPage);
      });
    });

    // ── Klik "Forecast Next Candles" ──
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"]');
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (text.includes('forecast next') || text.includes('forecast')) {
          btn.click();
          return;
        }
      }
    });

    // ── Tunggu tab baru terbuka (max 15 detik) ──
    let resultPage;
    try {
      resultPage = await Promise.race([
        newPagePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tab baru tidak muncul')), 15000))
      ]);
    } catch {
      // Kalau tidak ada tab baru, cek apakah hasil sudah muncul di halaman yang sama
      resultPage = page;
    }

    // ── Tunggu halaman hasil selesai load ──
    await resultPage.setViewport({ width: 1280, height: 900 });
    try {
      await resultPage.waitForFunction(
        () => document.body.innerText.includes('Confidence') ||
              document.body.innerText.includes('Forecast Result'),
        { timeout: 15000 }
      );
    } catch {
      await new Promise(r => setTimeout(r, 8000));
    }

    await new Promise(r => setTimeout(r, 1000));

    // ── Ekstrak hasil ──
    const result = await resultPage.evaluate(() => {
      const bodyText = document.body.innerText;

      // Prediksi: cari semua kemunculan GREEN/RED di bagian hasil
      const predictions = [];

      // Coba cari pola "#11 ... GREEN" atau "#11 ... RED" (dengan karakter apapun di tengah)
      const predRegex1 = /#(\d+)[\s\S]{0,30}?(GREEN|RED)/gi;
      let match;
      while ((match = predRegex1.exec(bodyText)) !== null) {
        predictions.push({ candle: match[1], color: match[2].toUpperCase() });
      }

      // Fallback: kalau tidak ketemu, cari di sekitar teks "Next ... Candle(s) Forecast"
      if (predictions.length === 0) {
        const forecastSection = bodyText.match(/Next[\s\S]{0,200}?(GREEN|RED)/i);
        if (forecastSection) {
          predictions.push({ candle: '?', color: forecastSection[1].toUpperCase() });
        }
      }

      // Fallback 2: ambil semua GREEN/RED yang muncul setelah kata "Forecast"
      if (predictions.length === 0) {
        const afterForecast = bodyText.split(/Forecast Result/i)[1] || bodyText;
        const colorMatches = afterForecast.match(/\b(GREEN|RED)\b/gi) || [];
        colorMatches.forEach((color, i) => {
          predictions.push({ candle: String(i + 1), color: color.toUpperCase() });
        });
      }

      // Confidence
      const confMatch = bodyText.match(/Confidence[:\s]+([\d.]+)%/i);
      const confidence = confMatch ? confMatch[1] : null;

      // Matching patterns
      const matchingMatch = bodyText.match(/([\d,]+)\s*matching patterns/i);
      const matchingCount = matchingMatch ? matchingMatch[1] : null;

      // DEBUG: log teks mentah halaman hasil
      console.log('=== RAW RESULT TEXT ===');
      console.log(bodyText.slice(0, 3000));
      console.log('=== END RAW TEXT ===');

      return { predictions, confidence, matchingCount };
    });

    return result;

  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT HASIL
// ─────────────────────────────────────────────────────────────────────────────
function formatResult(result, inputColors, forecastLength) {
  const inputLen = inputColors.length;
  const predictions = result.predictions.filter(p => parseInt(p.candle) > inputLen);

  let msg = `📊 *Hasil VEBTiQ Forecast*\n\n`;
  msg += `📥 *Input (${inputLen} candles):*\n`;
  msg += inputColors.map(c => c.includes('green') ? '🟢' : '🔴').join('') + '\n\n';

  if (predictions.length > 0) {
    msg += `🔮 *Prediksi ${forecastLength} Candle ke Depan:*\n`;
    predictions.slice(0, forecastLength).forEach((p, i) => {
      const emoji = p.color === 'GREEN' ? '🟢' : '🔴';
      const label = p.candle === '?' ? `Candle ${i + 1}` : `Candle #${p.candle}`;
      msg += `${label}: ${emoji} *${p.color}*\n`;
    });
  } else {
    msg += `⚠️ Tidak bisa parse hasil. Coba lagi.\n`;
  }

  if (result.confidence) {
    const confNum = parseFloat(result.confidence);
    const bar = confNum >= 60 ? '🟩' : confNum >= 50 ? '🟨' : '🟥';
    msg += `\n${bar} *Confidence: ${result.confidence}%*`;
  }

  if (result.matchingCount) {
    msg += `\n🔍 *Matching patterns: ${result.matchingCount}*`;
  }

  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────
function parseColors(input) {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, '-');
  if (/^[gr]+$/.test(normalized)) {
    return normalized.split('').map(c => c === 'g' ? 'green' : 'red');
  }
  const parts = normalized.split(/[-,\s]+/).filter(Boolean);
  const mapped = parts.map(p => {
    if (['g', 'green', 'hijau'].includes(p)) return 'green';
    if (['r', 'red', 'merah'].includes(p)) return 'red';
    return null;
  });
  if (mapped.includes(null)) return null;
  return mapped;
}



// ─────────────────────────────────────────────────────────────────────────────
// BOT COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Halo *${msg.from.first_name || 'Trader'}*!\n\nBot VEBTiQ Forecast siap 🕯️\n\nKetik /forecast untuk mulai.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/cancel/, (msg) => {
  delete sessions[msg.chat.id];
  bot.sendMessage(msg.chat.id, '✅ Dibatalkan. Ketik /forecast untuk mulai lagi.');
});

bot.onText(/\/forecast/, async (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 'choosing_length' };

  bot.sendMessage(chatId,
    `🕯️ *Berapa candle yang mau kamu input?*\n\nPilih jumlah pola candle (5–20):`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '5',  callback_data: 'len_5'  },
            { text: '6',  callback_data: 'len_6'  },
            { text: '7',  callback_data: 'len_7'  },
            { text: '8',  callback_data: 'len_8'  },
            { text: '9',  callback_data: 'len_9'  },
            { text: '10', callback_data: 'len_10' },
          ],
          [
            { text: '11', callback_data: 'len_11' },
            { text: '12', callback_data: 'len_12' },
            { text: '13', callback_data: 'len_13' },
            { text: '14', callback_data: 'len_14' },
            { text: '15', callback_data: 'len_15' },
          ],
          [
            { text: '16', callback_data: 'len_16' },
            { text: '17', callback_data: 'len_17' },
            { text: '18', callback_data: 'len_18' },
            { text: '19', callback_data: 'len_19' },
            { text: '20', callback_data: 'len_20' },
          ],
        ],
      },
    }
  );
});

// (text input tidak dipakai lagi — semua pakai tombol)

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const session = sessions[chatId];

  // ── Pilih jumlah candle ──
  if (data.startsWith('len_')) {
    const totalLen = parseInt(data.replace('len_', ''));
    bot.answerCallbackQuery(query.id);

    sessions[chatId] = {
      step: 'picking_colors',
      totalLen,
      colors: [],
    };

    await bot.editMessageText(
      `🕯️ *Pilih warna candle satu per satu*\n\n` +
      `Candle ke-*1* dari *${totalLen}*:\n\n` +
      `(belum ada input)`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: buildCandleKeyboard(0, totalLen),
      }
    );
    return;
  }

  // ── Pilih warna candle (GREEN/RED) ──
  if (data === 'candle_green' || data === 'candle_red') {
    if (!session || session.step !== 'picking_colors') {
      bot.answerCallbackQuery(query.id, { text: 'Sesi expired. Ketik /forecast lagi.' });
      return;
    }

    const color = data === 'candle_green' ? 'green' : 'red';
    session.colors.push(color);
    bot.answerCallbackQuery(query.id, { text: color === 'green' ? '🟢 GREEN' : '🔴 RED' });

    const current = session.colors.length;
    const total = session.totalLen;
    const pattern = showPattern(session.colors);

    if (current >= total) {
      // Semua candle sudah dipilih → tanya forecast length
      session.step = 'awaiting_forecast_length';
      await bot.editMessageText(
        `✅ *Pola lengkap (${total} candles):*\n${pattern}\n\nMau prediksi berapa candle ke depan?`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '1️⃣', callback_data: 'fl_1' },
              { text: '2️⃣', callback_data: 'fl_2' },
              { text: '3️⃣', callback_data: 'fl_3' },
              { text: '4️⃣', callback_data: 'fl_4' },
              { text: '5️⃣', callback_data: 'fl_5' },
            ]],
          },
        }
      );
    } else {
      // Masih ada candle yang belum dipilih
      await bot.editMessageText(
        `🕯️ *Pilih warna candle satu per satu*\n\n` +
        `Candle ke-*${current + 1}* dari *${total}*:\n\n` +
        `${pattern} ${'⬜'.repeat(total - current)}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: buildCandleKeyboard(current, total),
        }
      );
    }
    return;
  }

  // ── Undo (hapus candle terakhir) ──
  if (data === 'candle_undo') {
    if (!session || session.step !== 'picking_colors') {
      bot.answerCallbackQuery(query.id, { text: 'Tidak ada yang bisa dihapus.' });
      return;
    }
    if (session.colors.length === 0) {
      bot.answerCallbackQuery(query.id, { text: 'Belum ada candle yang dipilih!' });
      return;
    }

    session.colors.pop();
    bot.answerCallbackQuery(query.id, { text: '↩️ Dihapus' });

    const current = session.colors.length;
    const total = session.totalLen;
    const pattern = current > 0 ? showPattern(session.colors) : '(belum ada input)';

    await bot.editMessageText(
      `🕯️ *Pilih warna candle satu per satu*\n\n` +
      `Candle ke-*${current + 1}* dari *${total}*:\n\n` +
      `${pattern}${current > 0 ? ' ' : ''}${'⬜'.repeat(total - current)}`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: buildCandleKeyboard(current, total),
      }
    );
    return;
  }

  // ── Done (selesai lebih awal, minimal 5) ──
  if (data === 'candle_done') {
    if (!session || session.step !== 'picking_colors') {
      bot.answerCallbackQuery(query.id);
      return;
    }
    if (session.colors.length < 5) {
      bot.answerCallbackQuery(query.id, { text: `Minimal 5 candle! Baru ${session.colors.length}.` });
      return;
    }

    bot.answerCallbackQuery(query.id);
    session.totalLen = session.colors.length;
    session.step = 'awaiting_forecast_length';

    const pattern = showPattern(session.colors);
    await bot.editMessageText(
      `✅ *Pola lengkap (${session.colors.length} candles):*\n${pattern}\n\nMau prediksi berapa candle ke depan?`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '1️⃣', callback_data: 'fl_1' },
            { text: '2️⃣', callback_data: 'fl_2' },
            { text: '3️⃣', callback_data: 'fl_3' },
            { text: '4️⃣', callback_data: 'fl_4' },
            { text: '5️⃣', callback_data: 'fl_5' },
          ]],
        },
      }
    );
    return;
  }

  // ── Pilih forecast length ──
  if (data.startsWith('fl_')) {
    const forecastLength = parseInt(data.replace('fl_', ''));
    if (!session?.colors || session.colors.length < 5) {
      bot.answerCallbackQuery(query.id, { text: 'Sesi expired. Ketik /forecast lagi.' });
      return;
    }

    bot.answerCallbackQuery(query.id, { text: `⏳ Memproses...` });
    const savedColors = [...session.colors];
    delete sessions[chatId];

    const loadingMsg = await bot.sendMessage(chatId,
      `⏳ *Sedang analisis di VEBTiQ...*\n\n${showPattern(savedColors)}\n\n_Tunggu sekitar 20–30 detik..._`,
      { parse_mode: 'Markdown' }
    );

    try {
      const result = await getForecast(savedColors, forecastLength);
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      const msg = formatResult(result, savedColors, forecastLength);
      await bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Prediksi Lagi', callback_data: 'restart' }]] }
      });

    } catch (err) {
      console.error('Error:', err.message);
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nCoba lagi: /forecast`);
    }
    return;
  }

  // ── Restart ──
  if (data === 'restart') {
    bot.answerCallbackQuery(query.id);
    delete sessions[chatId];

    bot.sendMessage(chatId,
      `🕯️ *Berapa candle yang mau kamu input?*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '5',  callback_data: 'len_5'  },
              { text: '6',  callback_data: 'len_6'  },
              { text: '7',  callback_data: 'len_7'  },
              { text: '8',  callback_data: 'len_8'  },
              { text: '9',  callback_data: 'len_9'  },
              { text: '10', callback_data: 'len_10' },
            ],
            [
              { text: '11', callback_data: 'len_11' },
              { text: '12', callback_data: 'len_12' },
              { text: '13', callback_data: 'len_13' },
              { text: '14', callback_data: 'len_14' },
              { text: '15', callback_data: 'len_15' },
            ],
            [
              { text: '16', callback_data: 'len_16' },
              { text: '17', callback_data: 'len_17' },
              { text: '18', callback_data: 'len_18' },
              { text: '19', callback_data: 'len_19' },
              { text: '20', callback_data: 'len_20' },
            ],
          ],
        },
      }
    );
    return;
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
console.log('🤖 VEBTiQ Forecast Bot berjalan...');
