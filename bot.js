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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const sendStep = async (page, stepName) => {
    const ss = await page.screenshot({
      type: 'png',
      fullPage: true,
    });

    await bot.sendPhoto(chatId, ss, {
      caption: `🔍 ${stepName}`,
    });
  };

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: 1366,
      height: 900,
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'
    );

    // ─────────────────────────────
    // BUKA WEBSITE
    // ─────────────────────────────
    await page.goto(
      'https://vebtiq.com/flexible-pattern/forecast',
      {
        waitUntil: 'networkidle2',
        timeout: 60000,
      }
    );

    await sendStep(page, 'Halaman terbuka');

    const patternLength = colors.length;

    // ─────────────────────────────
    // PILIH PATTERN LENGTH
    // ─────────────────────────────
    await page.evaluate((pLen) => {
      const selects = [...document.querySelectorAll('select')];

      for (const sel of selects) {
        const found = [...sel.options].find(
          o =>
            o.value == pLen ||
            o.textContent.includes(String(pLen))
        );

        if (found) {
          sel.value = found.value;

          sel.dispatchEvent(
            new Event('input', { bubbles: true })
          );

          sel.dispatchEvent(
            new Event('change', { bubbles: true })
          );

          break;
        }
      }
    }, patternLength);

    await new Promise(r => setTimeout(r, 2000));

    await sendStep(
      page,
      `Pattern Length ${patternLength}`
    );

    // ─────────────────────────────
    // INPUT WARNA CANDLE
    // ─────────────────────────────
    const colorInputs = await page.$$(
      'input[type="text"]'
    );

    if (colorInputs.length >= patternLength) {
      for (let i = 0; i < patternLength; i++) {
        const input = colorInputs[i];

        await input.click({ clickCount: 3 });

        await page.keyboard.press('Backspace');

        await input.type(colors[i], {
          delay: 100,
        });

        await new Promise(r => setTimeout(r, 2000));
      }
    } else {
      // fallback
      const allSelects = await page.$$('select');

      let colorIndex = 0;

      for (const sel of allSelects) {
        const options = await sel.$$eval(
          'option',
          opts =>
            opts.map(o =>
              o.textContent.toLowerCase()
            )
        );

        if (
          options.includes('green') ||
          options.includes('red')
        ) {
          if (colors[colorIndex]) {
            await sel.select(colors[colorIndex]);
            colorIndex++;
          }
        }
      }
    }

    await page.waitForTimeout(1500);

    await sendStep(
      page,
      'Warna candle sudah diisi'
    );

    // ─────────────────────────────
    // FORECAST LENGTH
    // ─────────────────────────────
    const radios = await page.$$(
      'input[type="radio"]'
    );

    let radioClicked = false;

    for (const radio of radios) {
      const value = await page.evaluate(
        el => el.value,
        radio
      );

      if (String(value) === String(forecastLength)) {
        await radio.click();
        radioClicked = true;
        break;
      }
    }

    if (!radioClicked) {
      const selects = await page.$$('select');

      for (const sel of selects) {
        const options = await sel.$$eval(
          'option',
          opts =>
            opts.map(o => ({
              value: o.value,
              text: o.textContent,
            }))
        );

        const found = options.find(
          o =>
            o.value == forecastLength ||
            o.text.includes(
              `${forecastLength}`
            )
        );

        if (found) {
          await sel.select(found.value);
          break;
        }
      }
    }

    await new Promise(r => setTimeout(r, 2000));

    await sendStep(
      page,
      `Forecast Length ${forecastLength}`
    );

    // ─────────────────────────────
    // CARI TOMBOL FORECAST
    // ─────────────────────────────
    const buttons = await page.$$('button');

    let clicked = false;

    for (const btn of buttons) {
      const text = await page.evaluate(
        el => el.innerText.toLowerCase(),
        btn
      );

      console.log('BUTTON:', text);

      if (
        text.includes('forecast') ||
        text.includes('predict') ||
        text.includes('next candle')
      ) {
        await btn.evaluate(el => {
          el.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });

        await new Promise(r => setTimeout(r, 2000));

        await btn.click();

        clicked = true;

        console.log(
          '✅ Forecast button clicked'
        );

        break;
      }
    }

    if (!clicked) {
      throw new Error(
        'Tombol Forecast tidak ditemukan'
      );
    }

    // ─────────────────────────────
    // TUNGGU HASIL
    // ─────────────────────────────
    await page.waitForTimeout(7000);

    await page.evaluate(() => {
      window.scrollBy(0, 700);
    });

    await page.waitForTimeout(1500);

    await sendStep(
      page,
      '✅ HASIL FORECAST'
    );

    return true;

  } catch (err) {
    console.error(err);

    throw err;

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
