require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');

// ─── Cek Token ─────────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di file .env!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── Simpan state sementara per user ──────────────────────────────────────────
const sessions = {};

// ─────────────────────────────────────────────────────────────────────────────
// FUNGSI UTAMA: Buka VEBTiQ, isi form, ambil hasil
// ─────────────────────────────────────────────────────────────────────────────
async function getForecastFromWeb(colors, forecastLength) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    );

    // Buka halaman forecast
    await page.goto('https://vebtiq.com/flexible-pattern/forecast', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    const patternLength = colors.length;
    const colorString = colors.join('-');

    // Pilih Pattern Length di dropdown
    await page.select('select[name="pattern_length"], select#pattern_length, select', 
      String(patternLength)
    );
    await new Promise(r => setTimeout(r, 500)); // tunggu form update

    // Pilih Forecast Length (radio/select)
    // Coba berbagai kemungkinan selector
    try {
      // Jika berupa radio button
      await page.click(`input[name="forecast_length"][value="${forecastLength}"]`);
    } catch {
      try {
        // Jika berupa select
        await page.select('select[name="forecast_length"]', String(forecastLength));
      } catch {
        // Coba klik label ke-N
        const labels = await page.$$('input[type="radio"]');
        if (labels[forecastLength - 1]) {
          await labels[forecastLength - 1].click();
        }
      }
    }

    await new Promise(r => setTimeout(r, 300));

    // Isi input warna candle
    // Coba selector yang mungkin dipakai
    const inputSelectors = [
      'input[name="colors"]',
      'input[name="pattern"]',
      'input[placeholder*="color"]',
      'input[placeholder*="Color"]',
      'input[placeholder*="candle"]',
      '#colors',
      '#pattern',
      'input[type="text"]',
    ];

    let inputFound = false;
    for (const sel of inputSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 2000 });
        await page.click(sel, { clickCount: 3 }); // select all
        await page.type(sel, colorString);
        inputFound = true;
        break;
      } catch { /* coba selector berikutnya */ }
    }

    if (!inputFound) {
      // Fallback: isi semua input text yang ada
      const inputs = await page.$$('input[type="text"]:not([disabled])');
      if (inputs.length > 0) {
        await inputs[inputs.length - 1].click({ clickCount: 3 });
        await inputs[inputs.length - 1].type(colorString);
      }
    }

    await new Promise(r => setTimeout(r, 300));

    // Klik tombol Forecast
    const buttonSelectors = [
      'button[type="submit"]',
      'button:contains("Forecast")',
      'input[type="submit"]',
      '#forecast-btn',
      '.forecast-btn',
      'button',
    ];

    let buttonClicked = false;
    for (const sel of buttonSelectors) {
      try {
        // Cari tombol yang teksnya mengandung "Forecast"
        const btn = await page.evaluateHandle((selector) => {
          const buttons = document.querySelectorAll('button, input[type="submit"]');
          for (const b of buttons) {
            if (b.textContent.toLowerCase().includes('forecast') || 
                b.value?.toLowerCase().includes('forecast')) {
              return b;
            }
          }
          return null;
        });

        if (btn && btn.asElement()) {
          await btn.click();
          buttonClicked = true;
          break;
        }
      } catch { /* lanjut */ }
    }

    if (!buttonClicked) {
      // Fallback: klik submit button pertama
      await page.click('button[type="submit"], input[type="submit"]').catch(() => {});
    }

    // Tunggu hasil muncul (max 15 detik)
    await new Promise(r => setTimeout(r, 3000));

    // Ambil hasil dari halaman
    const result = await page.evaluate(() => {
      // Cari elemen yang mengandung hasil prediksi
      // Coba berbagai kemungkinan container hasil
      const resultSelectors = [
        '#result', '#forecast-result', '.forecast-result',
        '#results', '.results', '.result',
        '.prediction', '#prediction',
        '[class*="result"]', '[class*="forecast"]',
        '[id*="result"]', '[id*="forecast"]',
      ];

      for (const sel of resultSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          return { found: true, text: el.textContent.trim(), html: el.innerHTML };
        }
      }

      // Cari teks yang mengandung green/red/GREEN/RED sebagai hasil
      const allElements = document.querySelectorAll('p, div, span, td, li, h1, h2, h3, h4, h5');
      for (const el of allElements) {
        const text = el.textContent.trim().toLowerCase();
        if ((text.includes('green') || text.includes('red')) &&
            (text.includes('forecast') || text.includes('prediction') || 
             text.includes('next') || text.includes('candle') ||
             text.includes('result'))) {
          // Ambil parent-nya juga
          return { 
            found: true, 
            text: el.closest('div, section, article')?.textContent?.trim() || text,
            html: el.innerHTML
          };
        }
      }

      // Last resort: ambil body text yang mungkin jadi hasil
      return { 
        found: false, 
        text: document.body.innerText.slice(0, 1000),
        html: ''
      };
    });

    return result;

  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

// Parse input user → array of 'green'/'red'
function parseColors(input) {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, '-');

  // Format GRGRG (tanpa pemisah)
  if (/^[gr]+$/.test(normalized)) {
    return normalized.split('').map(c => (c === 'g' ? 'green' : 'red'));
  }

  // Format green-red atau g-r
  const parts = normalized.split(/[-,\s]+/).filter(Boolean);
  const mapped = parts.map(p => {
    if (p === 'g' || p === 'green' || p === 'hijau') return 'green';
    if (p === 'r' || p === 'red' || p === 'merah') return 'red';
    return null;
  });

  if (mapped.includes(null)) return null;
  return mapped;
}

// Candle → emoji
function candleEmoji(color) {
  return color.toLowerCase().includes('green') ? '🟢' : '🔴';
}

// Format array warna → emoji
function showPattern(colors) {
  return colors.map(candleEmoji).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// PERINTAH BOT
// ─────────────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'Trader';
  bot.sendMessage(msg.chat.id,
    `👋 Halo *${name}*!\n\n` +
    `Selamat datang di *VEBTiQ Forecast Bot* 🕯️\n\n` +
    `Bot ini memprediksi candle berikutnya berdasarkan pola historis dari vebtiq.com\n\n` +
    `*Cara pakai:*\n` +
    `Ketik /forecast lalu ikuti langkahnya\n\n` +
    `*Format input candle:*\n` +
    `• \`green-red-green-red\`\n` +
    `• \`g-r-g-r\` (singkatan)\n` +
    `• \`GRGRG\` (tanpa pemisah)\n` +
    `• \`hijau-merah-hijau\` (bahasa Indonesia)\n\n` +
    `Ketik /help untuk bantuan.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *Panduan VEBTiQ Forecast Bot*\n\n` +
    `*Perintah:*\n` +
    `/forecast - Mulai prediksi baru\n` +
    `/cancel - Batalkan sesi\n` +
    `/help - Bantuan\n\n` +
    `*Jumlah candle input:* 5–20 candle\n` +
    `*Jumlah prediksi:* 1–5 candle ke depan\n\n` +
    `*Contoh 10 candle:*\n` +
    `\`green-red-green-green-red-green-red-red-green-red\`\n` +
    `atau: \`GRGGRGRRG R\``,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/cancel/, (msg) => {
  delete sessions[msg.chat.id];
  bot.sendMessage(msg.chat.id, '✅ Sesi dibatalkan. Ketik /forecast untuk mulai lagi.');
});

bot.onText(/\/forecast/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 'awaiting_colors' };

  bot.sendMessage(chatId,
    `🕯️ *Langkah 1: Masukkan Pola Candle*\n\n` +
    `Ketik *5 sampai 20* warna candle.\n\n` +
    `Contoh (10 candle):\n` +
    `\`green-red-green-red-green-red-green-red-green-red\`\n\n` +
    `Atau pakai singkatan:\n` +
    `\`GRGRGRGRG R\`\n\n` +
    `_Ketik /cancel untuk batal_`,
    { parse_mode: 'Markdown' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PESAN BIASA (flow langkah demi langkah)
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const session = sessions[chatId];
  if (!session) return;

  // ── Langkah 1: Terima pola candle ──
  if (session.step === 'awaiting_colors') {
    const colors = parseColors(text);

    if (!colors) {
      return bot.sendMessage(chatId,
        `❌ Format tidak dikenali!\n\n` +
        `Contoh yang benar:\n` +
        `• \`green-red-green-red-green\`\n` +
        `• \`GRGRG\`\n` +
        `• \`g-r-g-r-g\``,
        { parse_mode: 'Markdown' }
      );
    }

    if (colors.length < 5 || colors.length > 20) {
      return bot.sendMessage(chatId,
        `❌ Jumlah candle harus *5–20*.\n` +
        `Kamu memasukkan *${colors.length}* candle. Coba lagi!`,
        { parse_mode: 'Markdown' }
      );
    }

    sessions[chatId].colors = colors;
    sessions[chatId].step = 'awaiting_forecast_length';

    bot.sendMessage(chatId,
      `✅ *Pola diterima (${colors.length} candles):*\n${showPattern(colors)}\n\n` +
      `🔢 *Langkah 2: Mau prediksi berapa candle ke depan?*`,
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

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER TOMBOL INLINE
// ─────────────────────────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Pilih jumlah forecast candle
  if (data.startsWith('fl_')) {
    const forecastLength = parseInt(data.replace('fl_', ''));
    const session = sessions[chatId];

    if (!session?.colors) {
      bot.answerCallbackQuery(query.id, { text: 'Sesi expired. Ketik /forecast lagi.' });
      return;
    }

    bot.answerCallbackQuery(query.id, { text: `Oke! Prediksi ${forecastLength} candle...` });

    // Update pesan dengan loading
    const loadingMsg = await bot.sendMessage(chatId,
      `⏳ *Sedang memproses...*\n\n` +
      `🔍 Membuka VEBTiQ dan menganalisis pola\n` +
      `${showPattern(session.colors)}\n\n` +
      `_Mohon tunggu 10–30 detik..._`,
      { parse_mode: 'Markdown' }
    );

    delete sessions[chatId];

    try {
      const result = await getForecastFromWeb(session.colors, forecastLength);

      // Hapus pesan loading
      bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      // Buat pesan hasil
      let replyText = `📊 *Hasil VEBTiQ Forecast*\n\n`;
      replyText += `📥 *Input (${session.colors.length} candles):*\n`;
      replyText += showPattern(session.colors) + '\n\n';
      replyText += `🔮 *Prediksi ${forecastLength} candle ke depan:*\n`;

      if (result.found) {
        // Parse hasil: cari pola green/red di teks
        const text = result.text.toLowerCase();
        const predictions = [];

        // Cari kata green/red berurutan
        const words = text.split(/[\s,.\-\/|→]+/);
        for (const word of words) {
          if (word === 'green') predictions.push('green');
          else if (word === 'red') predictions.push('red');
          if (predictions.length >= forecastLength) break;
        }

        if (predictions.length > 0) {
          predictions.forEach((color, i) => {
            replyText += `Candle ${i + 1}: ${candleEmoji(color)} *${color.toUpperCase()}*\n`;
          });
        } else {
          // Tampilkan teks mentah jika tidak bisa parse
          replyText += `\`\`\`\n${result.text.slice(0, 300)}\n\`\`\`\n`;
          replyText += `\n_Tidak bisa otomatis parse hasilnya. Lihat teks di atas._`;
        }
      } else {
        replyText += `⚠️ Tidak bisa mengambil hasil secara otomatis.\n`;
        replyText += `Silakan cek langsung di:\n`;
        replyText += `https://vebtiq.com/flexible-pattern/forecast`;
      }

      bot.sendMessage(chatId, replyText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Prediksi Lagi', callback_data: 'restart' }
          ]]
        }
      });

    } catch (err) {
      console.error('Error:', err.message);
      bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(chatId,
        `❌ *Gagal mengambil prediksi*\n\n` +
        `Error: ${err.message}\n\n` +
        `Coba lagi dengan /forecast`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Restart
  if (data === 'restart') {
    bot.answerCallbackQuery(query.id);
    sessions[chatId] = { step: 'awaiting_colors' };
    bot.sendMessage(chatId,
      `🕯️ *Masukkan Pola Candle Baru*\n\n` +
      `Ketik 5–20 warna candle:\n` +
      `Contoh: \`green-red-green-red-green-red-green-red-green-red\``,
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── Error handler ─────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('🤖 VEBTiQ Forecast Bot berjalan...');
console.log('📡 Polling Telegram...');
