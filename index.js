require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');
const express = require('express');
const LRU = require('lru-cache');
const schedule = require('node-schedule');
const FormData = require('form-data');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const port = process.env.PORT || 10000;

const ADMIN_ID = process.env.ADMIN_ID;
const CHANNEL = process.env.FORCE_SUB_CHANNEL;
const IS_FREE_MODE = process.env.IS_FREE_MODE === 'true';

const pending = {};
const memberCache = new LRU({ max: 500, ttl: 1000 * 60 * 5 });

app.get('/', (_, res) => res.send('Bot is running!'));
app.listen(port, () => console.log(`✅ HTTP server on port ${port}`));

// 🔐 Check subscription
async function ensureSubscribed(ctx) {
  if (!CHANNEL || IS_FREE_MODE) return true;
  const userId = ctx.from.id;
  if (memberCache.get(userId)) return true;

  try {
    const member = await ctx.telegram.getChatMember('@' + CHANNEL, userId);
    if (['creator', 'administrator', 'member'].includes(member.status)) {
      memberCache.set(userId, true);
      return true;
    }
  } catch {}

  await ctx.reply('📢 Please join our channel to use this bot:', {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.url('✅ Join Channel', 'https://t.me/' + CHANNEL)],
      [Markup.button.callback('🔄 I Joined', 'refresh')]
    ])
  });
  return false;
}

// 🔁 Refresh Join Check
bot.action('refresh', async ctx => {
  if (await ensureSubscribed(ctx)) {
    return ctx.reply('✅ Access granted! Now send me an image to upload.');
  }
});

// 🚀 Start
bot.start(async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  ctx.reply('👋 Welcome to Image to URL Bot!\n\n📸 Send me an image and I’ll convert it to a Telegraph link.\n\n🛠️ Powered by WHIZ', Markup.inlineKeyboard([
    [Markup.button.callback('ℹ️ Help', 'HELP')],
    [Markup.button.url('📢 Channel', 'https://t.me/' + CHANNEL)]
  ]));
});

// ℹ️ Help
bot.action('HELP', ctx => {
  ctx.editMessageText('📌 *How to Use This Bot:*\n\n1. Send any image.\n2. Confirm upload.\n3. Get your Telegraph link.\n\n🆓 Free to use during launch period.\n🛠 By WHIZ', { parse_mode: 'Markdown' });
});

// 🖼 Handle Images
bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  const p = ctx.message.photo.slice(-1)[0];
  const f = await ctx.telegram.getFile(p.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`;

  const imgResp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const image = await sharp(imgResp.data).metadata();

  pending[ctx.from.id] = {
    file_id: p.file_id,
    file_path: f.file_path,
    metadata: image
  };

  const infoText = `🖼️ Image ready to upload\n📏 ${image.width}×${image.height}px • ${image.format}`;
  const preview = { url: fileUrl };

  const msg = await ctx.replyWithPhoto(preview, {
    caption: infoText,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm','CONFIRM')],
      [Markup.button.callback('❌ Cancel','CANCEL')]
    ])
  });

  pending[ctx.from.id].msg_id = msg.message_id;
});

// ❌ Cancel Upload
bot.action('CANCEL', ctx => {
  delete pending[ctx.from.id];
  ctx.deleteMessage();
  ctx.reply('❌ Upload cancelled.');
});

// ✅ Confirm Upload
bot.action('CONFIRM', async ctx => {
  ctx.deleteMessage();
  const p = pending[ctx.from.id];
  if (!p) return ctx.reply('❗ Nothing to upload. Send an image.');

  try {
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${p.file_path}`;
    const form = new FormData();
    form.append('file', await axios.get(fileUrl, { responseType: 'stream' }).then(r => r.data), {
      filename: 'upload.jpg',
      contentType: 'image/jpeg'
    });

    const res = await axios.post('https://telegra.ph/upload', form, {
      headers: form.getHeaders()
    });

    if (!res.data[0] || !res.data[0].src) throw new Error('No file returned');

    const finalUrl = 'https://telegra.ph' + res.data[0].src;
    ctx.reply(`✅ Published: ${finalUrl}`, {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('🌐 Open', finalUrl)],
        [Markup.button.callback('🔙 Back', 'HELP')]
      ])
    });
  } catch (e) {
    ctx.reply('❌ Upload failed. Try again later.');
  }

  delete pending[ctx.from.id];
});

// 👮‍♂️ Admin Command: Broadcast
bot.command('broadcast', async ctx => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return ctx.reply('❗ Usage: /broadcast <message>');
  ctx.reply('✅ (Simulation) Broadcast sent!');
});

// Launch
bot.launch().then(() => console.log('🤖 Bot running'));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));



// --- Webhook Server Setup ---
const app = express();
const webhookPath = `/bot${process.env.BOT_TOKEN}`;
bot.telegram.setWebhook((process.env.RENDER_EXTERNAL_URL || '') + webhookPath);
app.use(bot.webhookCallback(webhookPath));
app.get('/', (_, res) => res.send('✅ Bot running'));
app.listen(process.env.PORT || 3000, () => console.log('Webhook listening'));
