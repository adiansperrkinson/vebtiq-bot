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
// FUNGSI UTAMA: Buka VEBTiQ → isi form → screenshot hasil
// ─────────────────────────────────────────────────────────────────────────────
async function getForecastScreenshot(colors, forecastLength) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    console.log('🌐 Membuka VEBTiQ...');
    await page.goto('https://vebtiq.com/flexible-pattern/forecast', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Dump semua selector yang ada di halaman untuk debug
    const pageInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        tag: 'select', id: s.id, name: s.name, class: s.className,
        options: Array.from(s.options).map(o => ({ value: o.value, text: o.text }))
      }));
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        tag: 'input', id: i.id, name: i.name, type: i.type, class: i.className, placeholder: i.placeholder
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        tag: 'button', id: b.id, text: b.textContent.trim(), type: b.type, class: b.className
      }));
      return { selects, inputs, buttons };
    });

    console.log('📋 Page elements:', JSON.stringify(pageInfo, null, 2));

    const patternLength = colors.length;
    const colorString = colors.join('-');

    // ── Pilih Pattern Length ──
    if (pageInfo.selects.length > 0) {
      const patternSelect = pageInfo.selects[0];
      const matchingOption = patternSelect.options.find(o =>
        o.value == patternLength || o.text.includes(String(patternLength))
      );

      if (matchingOption) {
        const sel = patternSelect.id ? `#${patternSelect.id}` :
                    patternSelect.name ? `select[name="${patternSelect.name}"]` : 'select';
        await page.select(sel, matchingOption.value);
        console.log(`✅ Pattern length dipilih: ${matchingOption.value}`);
      }
    }

    await new Promise(r => setTimeout(r, 800));

    // ── Pilih Forecast Length ──
    // Coba radio buttons dulu
    const radioClicked = await page.evaluate((fLen) => {
      const radios = document.querySelectorAll('input[type="radio"]');
      // Radio ke-N (index forecastLength - 1)
      if (radios[fLen - 1]) { radios[fLen - 1].click(); return true; }
      // Atau cari by value
      for (const r of radios) {
        if (r.value == fLen) { r.click(); return true; }
      }
      return false;
    }, forecastLength);

    if (!radioClicked && pageInfo.selects.length > 1) {
      const fSelect = pageInfo.selects[1];
      const sel = fSelect.id ? `#${fSelect.id}` :
                  fSelect.name ? `select[name="${fSelect.name}"]` : 'select:nth-of-type(2)';
      const fOption = fSelect.options.find(o => o.value == forecastLength || o.text.includes(String(forecastLength)));
      if (fOption) await page.select(sel, fOption.value);
    }

    await new Promise(r => setTimeout(r, 500));

    // ── Isi Input Warna ──
    const textInput = pageInfo.inputs.find(i =>
      i.type === 'text' || i.type === '' || i.type === undefined
    );

    if (textInput) {
      const inputSel = textInput.id ? `#${textInput.id}` :
                       textInput.name ? `input[name="${textInput.name}"]` : 'input[type="text"]';
      await page.click(inputSel, { clickCount: 3 });
      await page.type(inputSel, colorString, { delay: 20 });
      console.log(`✅ Input diisi: ${colorString}`);
    } else {
      // Fallback: isi semua input text
      await page.evaluate((colorStr) => {
        const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
        if (inputs.length > 0) {
          const last = inputs[inputs.length - 1];
          last.value = colorStr;
          last.dispatchEvent(new Event('input', { bubbles: true }));
          last.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, colorString);
    }

    await new Promise(r => setTimeout(r, 500));

    // ── Klik Tombol Forecast ──
    const clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"]');
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (text.includes('forecast') || text.includes('predict') || text.includes('submit')) {
          btn.click();
          return btn.textContent || btn.value;
        }
      }
      // Klik button terakhir sebagai fallback
      if (buttons.length > 0) {
        buttons[buttons.length - 1].click();
        return 'last button';
      }
      return null;
    });

    console.log(`✅ Tombol diklik: ${clicked}`);

    // ── Tunggu hasil muncul ──
    await new Promise(r => setTimeout(r, 4000));

    // Scroll ke bawah untuk pastikan hasil terlihat
    await page.evaluate(() => window.scrollBy(0, 400));
    await new Promise(r => setTimeout(r, 500));

    // Screenshot full page
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: true,
    });

    // Ambil juga teks hasil untuk parsing
    const resultText = await page.evaluate(() => document.body.innerText);

    return { screenshot, resultText };

  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
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

function candleEmoji(color) {
  return color.toLowerCase().includes('green') ? '🟢' : '🔴';
}

function showPattern(colors) {
  return colors.map(candleEmoji).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'Trader';
  bot.sendMessage(msg.chat.id,
    `👋 Halo *${name}*!\n\n` +
    `Selamat datang di *VEBTiQ Forecast Bot* 🕯️\n\n` +
    `Ketik /forecast untuk mulai prediksi candle.\n\n` +
    `*Format input candle:*\n` +
    `• \`green-red-green-red\`\n` +
    `• \`g-r-g-r\`\n` +
    `• \`GRGRG\`\n` +
    `• \`hijau-merah-hijau\``,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/cancel/, (msg) => {
  delete sessions[msg.chat.id];
  bot.sendMessage(msg.chat.id, '✅ Dibatalkan. Ketik /forecast untuk mulai lagi.');
});

bot.onText(/\/forecast/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 'awaiting_colors' };
  bot.sendMessage(chatId,
    `🕯️ *Masukkan Pola Candle*\n\n` +
    `Ketik *5–20* warna candle.\n\n` +
    `Contoh 10 candle:\n` +
    `\`green-red-green-red-green-red-green-red-green-red\`\n\n` +
    `Atau singkatan: \`GRGRGRGRG R\`\n\n` +
    `_Ketik /cancel untuk batal_`,
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
        `❌ Format tidak dikenali!\n\nContoh: \`green-red-green-red-green\` atau \`GRGRG\``,
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
      `✅ *Pola diterima (${colors.length} candles):*\n${showPattern(colors)}\n\n` +
      `🔢 Mau prediksi berapa candle ke depan?`,
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

    bot.answerCallbackQuery(query.id, { text: `⏳ Memproses ${forecastLength} candle...` });

    const loadingMsg = await bot.sendMessage(chatId,
      `⏳ *Sedang analisis...*\n\n` +
      `${showPattern(session.colors)}\n\n` +
      `_Membuka VEBTiQ dan mengisi form otomatis...\nTunggu 15–30 detik ya!_`,
      { parse_mode: 'Markdown' }
    );

    const savedColors = session.colors;
    delete sessions[chatId];

    try {
      const { screenshot, resultText } = await getForecastScreenshot(savedColors, forecastLength);

      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      // Kirim screenshot langsung — user lihat hasil persis seperti di web!
      await bot.sendPhoto(chatId, screenshot, {
        caption:
          `📊 *Hasil VEBTiQ Forecast*\n` +
          `Input: ${showPattern(savedColors)} (${savedColors.length} candles)\n` +
          `Prediksi: ${forecastLength} candle ke depan`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Prediksi Lagi', callback_data: 'restart' }
          ]]
        }
      });

    } catch (err) {
      console.error('Error:', err.message);
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(chatId,
        `❌ *Gagal mengambil hasil*\n\nError: ${err.message}\n\nCoba lagi: /forecast`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  if (data === 'restart') {
    bot.answerCallbackQuery(query.id);
    sessions[chatId] = { step: 'awaiting_colors' };
    bot.sendMessage(chatId,
      `🕯️ *Masukkan Pola Candle Baru*\n\nKetik 5–20 warna candle:\n\`green-red-green-red-...\``,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
console.log('🤖 VEBTiQ Forecast Bot berjalan...');
