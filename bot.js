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
// FUNGSI UTAMA
// ─────────────────────────────────────────────────────────────────────────────
async function getForecast(colors, forecastLength, chatId) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const sendStep = async (page, stepName) => {
    const ss = await page.screenshot({ type: 'png', fullPage: true });
    await bot.sendPhoto(chatId, ss, { caption: `🔍 Debug: ${stepName}` });
  };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    // ── Langkah 1: Buka halaman ──
    await page.goto('https://vebtiq.com/flexible-pattern/forecast', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await sendStep(page, 'Halaman terbuka');

    const patternLength = colors.length;
    const colorString = colors.join('-');

    // ── Langkah 2: Pilih Pattern Length ──
    // Cari select yang punya option dengan angka patternLength
    await page.evaluate((pLen) => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.value == pLen || opt.text.includes(String(pLen))) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          }
        }
      }
    }, patternLength);

    await new Promise(r => setTimeout(r, 1500)); // tunggu input dinamis muncul
    await sendStep(page, `Setelah pilih pattern length ${patternLength}`);

    // ── Langkah 3: Isi warna candle ──
    // Cek apakah ada banyak input (satu per candle) atau satu input teks
    const inputInfo = await page.evaluate((colorStr, pLen) => {
      const allInputs = document.querySelectorAll('input[type="text"], input:not([type]), input[type="color"]');
      const results = [];
      allInputs.forEach((inp, i) => {
        results.push({ index: i, id: inp.id, name: inp.name, placeholder: inp.placeholder, value: inp.value, type: inp.type });
      });

      // Juga cari textarea
      const textareas = document.querySelectorAll('textarea');
      textareas.forEach((ta, i) => {
        results.push({ index: i, tag: 'textarea', id: ta.id, name: ta.name, placeholder: ta.placeholder });
      });

      return results;
    }, colorString, patternLength);

    console.log('Input elements ditemukan:', JSON.stringify(inputInfo, null, 2));

    const colorArray = colors; // ['green', 'red', 'green', ...]

    if (inputInfo.length >= patternLength) {
      // Kemungkinan ada input terpisah per candle
      await page.evaluate((colorArr) => {
        const inputs = document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])');
        colorArr.forEach((color, i) => {
          if (inputs[i]) {
            inputs[i].value = color;
            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }, colorArray);
    } else if (inputInfo.length === 1) {
      // Satu input teks → isi dengan format green-red-green
      const inp = inputInfo[0];
      const sel = inp.id ? `#${inp.id}` : inp.name ? `input[name="${inp.name}"]` : 'input[type="text"]';
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, colorString, { delay: 30 });
    } else {
      // Tidak ada input text → coba isi via select/dropdown per candle
      await page.evaluate((colorArr) => {
        const selects = document.querySelectorAll('select');
        // Skip select pertama (pattern length) dan kedua mungkin forecast length
        let offset = 0;
        for (let i = 0; i < selects.length; i++) {
          // Cek apakah select ini untuk warna candle
          const opts = Array.from(selects[i].options).map(o => o.value.toLowerCase());
          if (opts.includes('green') || opts.includes('red')) {
            const colorIdx = i - offset;
            if (colorArr[colorIdx]) {
              selects[i].value = colorArr[colorIdx];
              selects[i].dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else {
            offset++;
          }
        }
      }, colorArray);
    }

    await new Promise(r => setTimeout(r, 800));
    await sendStep(page, 'Setelah isi warna candle');

    // ── Langkah 4: Pilih Forecast Length ──
    await page.evaluate((fLen) => {
      // Coba radio button
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const r of radios) {
        if (r.value == fLen) { r.click(); return; }
      }
      // Coba radio ke-index
      if (radios[fLen - 1]) { radios[fLen - 1].click(); return; }

      // Coba select untuk forecast
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.value == fLen || opt.text.includes(`${fLen} Candle`)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      }
    }, forecastLength);

    await new Promise(r => setTimeout(r, 500));

    // ── Langkah 5: Klik Forecast Button ──
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"], a');
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (text.includes('forecast') || text.includes('predict') || text.includes('next candle')) {
          btn.click();
          return;
        }
      }
      // Fallback: klik semua button yang bukan reset/cancel
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (!text.includes('reset') && !text.includes('cancel') && !text.includes('example')) {
          if (btn.tagName === 'BUTTON' || btn.type === 'submit') {
            btn.click();
            return;
          }
        }
      }
    });

    // Tunggu hasil muncul
    await new Promise(r => setTimeout(r, 5000));
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise(r => setTimeout(r, 500));

    await sendStep(page, '✅ Setelah klik Forecast — INI HASILNYA');

    return true;

  } finally {
    await browser.close();
  }
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

function showPattern(colors) {
  return colors.map(c => c.includes('green') ? '🟢' : '🔴').join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Halo *${msg.from.first_name || 'Trader'}*!\n\n` +
    `Bot VEBTiQ Forecast siap dipakai 🕯️\n\nKetik /forecast untuk mulai.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/cancel/, (msg) => {
  delete sessions[msg.chat.id];
  bot.sendMessage(msg.chat.id, '✅ Dibatalkan. Ketik /forecast untuk mulai lagi.');
});

bot.onText(/\/forecast/, (msg) => {
  sessions[msg.chat.id] = { step: 'awaiting_colors' };
  bot.sendMessage(msg.chat.id,
    `🕯️ *Masukkan Pola Candle*\n\n` +
    `Ketik *5–20* warna candle.\n\n` +
    `Contoh 10 candle:\n` +
    `\`green-red-green-red-green-red-green-red-green-red\`\n\n` +
    `Atau singkatan: \`GRGRGRGRG R\``,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;
  const session = sessions[chatId];
  if (!session) return;

  if (session.step === 'awaiting_colors') {
    const colors = parseColors(text);
    if (!colors) return bot.sendMessage(chatId, `❌ Format salah. Contoh: \`GRGRGRGRGRG\``, { parse_mode: 'Markdown' });
    if (colors.length < 5 || colors.length > 20) return bot.sendMessage(chatId, `❌ Harus 5–20 candle. Kamu input ${colors.length}.`);

    sessions[chatId].colors = colors;
    sessions[chatId].step = 'awaiting_forecast_length';

    bot.sendMessage(chatId,
      `✅ *Pola diterima (${colors.length} candles):*\n${showPattern(colors)}\n\nMau prediksi berapa candle ke depan?`,
      {
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
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('fl_')) {
    const forecastLength = parseInt(data.replace('fl_', ''));
    const session = sessions[chatId];
    if (!session?.colors) {
      bot.answerCallbackQuery(query.id, { text: 'Sesi expired. Ketik /forecast lagi.' });
      return;
    }

    bot.answerCallbackQuery(query.id, { text: `⏳ Memproses...` });
    const savedColors = session.colors;
    delete sessions[chatId];

    await bot.sendMessage(chatId,
      `⏳ *Sedang memproses...*\n${showPattern(savedColors)}\n\n_Kamu akan menerima beberapa screenshot debug. Screenshot terakhir = hasil forecast!_`,
      { parse_mode: 'Markdown' }
    );

    try {
      await getForecast(savedColors, forecastLength, chatId);
      bot.sendMessage(chatId,
        `✅ *Selesai!* Screenshot terakhir di atas adalah hasil forecast.\n\nMau prediksi lagi?`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔄 Prediksi Lagi', callback_data: 'restart' }]] }
        }
      );
    } catch (err) {
      console.error('Error:', err.message);
      bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nCoba lagi: /forecast`);
    }
  }

  if (data === 'restart') {
    bot.answerCallbackQuery(query.id);
    sessions[chatId] = { step: 'awaiting_colors' };
    bot.sendMessage(chatId, `🕯️ Ketik pola candle baru (5–20):\nContoh: \`GRGRGRGRG R\``, { parse_mode: 'Markdown' });
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
console.log('🤖 VEBTiQ Forecast Bot berjalan...');
