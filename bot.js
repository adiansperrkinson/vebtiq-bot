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

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    // ── Buka halaman ──
    await page.goto('https://vebtiq.com/flexible-pattern/forecast', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 1000));

    const patternLength = colors.length;
    const colorString = colors.join('-');

    // ── Pilih Pattern Length (select pertama) ──
    // Nilai option-nya kemungkinan "5", "6", dst
    await page.evaluate((pLen) => {
      const selects = document.querySelectorAll('select');
      const sel = selects[0]; // select pertama = Pattern Length
      if (!sel) return;

      // Coba set by value langsung
      for (const opt of sel.options) {
        if (
          opt.value == pLen ||
          opt.text.trim().startsWith(String(pLen))
        ) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, patternLength);

    await new Promise(r => setTimeout(r, 800));

    // ── Pilih Forecast Length (select kedua) ──
    await page.evaluate((fLen) => {
      const selects = document.querySelectorAll('select');
      const sel = selects[1]; // select kedua = Forecast Length
      if (!sel) return;

      for (const opt of sel.options) {
        if (
          opt.value == fLen ||
          opt.text.trim().startsWith(String(fLen))
        ) {
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

    // ── Klik "Forecast Next Candles" ──
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (text.includes('forecast next') || text.includes('forecast')) {
          btn.click();
          return;
        }
      }
    });

    // Tunggu hasil muncul (sampai 10 detik)
    await new Promise(r => setTimeout(r, 8000));

    // Scroll ke bawah untuk pastikan hasil terlihat
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 1000));

    // Screenshot hasil
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    return screenshot;

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
    `Bot VEBTiQ Forecast siap 🕯️\n\nKetik /forecast untuk mulai prediksi.`,
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
    `Atau singkatan: \`GRGRGRGRGRG\``,
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
    if (!colors) {
      return bot.sendMessage(chatId,
        `❌ Format tidak dikenali.\n\nContoh: \`green-red-green-red-green\` atau \`GRGRG\``,
        { parse_mode: 'Markdown' }
      );
    }
    if (colors.length < 5 || colors.length > 20) {
      return bot.sendMessage(chatId,
        `❌ Harus *5–20* candle. Kamu input *${colors.length}* candle.`,
        { parse_mode: 'Markdown' }
      );
    }

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

    const loadingMsg = await bot.sendMessage(chatId,
      `⏳ *Sedang memproses...*\n\n` +
      `${showPattern(savedColors)}\n\n` +
      `_Mohon tunggu sekitar 20–30 detik..._`,
      { parse_mode: 'Markdown' }
    );

    try {
      const screenshot = await getForecast(savedColors, forecastLength, chatId);

      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      await bot.sendPhoto(chatId, screenshot, {
        caption:
          `📊 *Hasil VEBTiQ Forecast*\n` +
          `Input: ${showPattern(savedColors)} (${savedColors.length} candles)\n` +
          `Prediksi: ${forecastLength} candle ke depan`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Prediksi Lagi', callback_data: 'restart' }]]
        }
      });

    } catch (err) {
      console.error('Error:', err.message);
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nCoba lagi: /forecast`);
    }
  }

  if (data === 'restart') {
    bot.answerCallbackQuery(query.id);
    sessions[chatId] = { step: 'awaiting_colors' };
    bot.sendMessage(chatId,
      `🕯️ Ketik pola candle baru (5–20):\nContoh: \`GRGRGRGRGRG\``,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
console.log('🤖 VEBTiQ Forecast Bot berjalan...');
