require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const schedule = require('node-schedule');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');
const http = require('http');

// ─── CONFIG ─────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH))
  : {
      channel: process.env.FORCE_SUB_CHANNEL.replace(/^@/, ''),
      banned: [],
      stats: { requests: 0, users: {} },
      referrals: {},
      recoveryTokens: {},
      uploads: {},
    };
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── ENV ────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = +process.env.ADMIN_ID;
const BOT_USERNAME = process.env.BOT_USERNAME;
const IS_FREE_MODE = process.env.IS_FREE_MODE === 'true';
const memberCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 });

// ─── UTIL ───────────────────────────────
function log(action, ctx) {
  console.log(`[${new Date().toISOString()}] ${action} by ${ctx.from.username || ctx.from.id}`);
}

async function ensureSubscribed(ctx) {
  const uid = ctx.from.id;
  if (config.banned.includes(uid)) {
    await ctx.reply('🚫 You are banned.');
    return false;
  }

  if (!memberCache.has(uid)) {
    try {
      const member = await ctx.telegram.getChatMember(`@${config.channel}`, uid);
      const ok = ['member', 'creator', 'administrator'].includes(member.status);
      if (!ok) throw 0;
      memberCache.set(uid, true);
    } catch {
      return ctx.replyWithHTML(
        `🔒 Please <b>join @${config.channel}</b> to use this bot`,
        Markup.inlineKeyboard([
          [Markup.button.url('➡️ Join Channel', `https://t.me/${config.channel}`)],
          [Markup.button.callback('🔄 I Joined', 'CHECK_JOIN')],
        ])
      );
    }
  }

  return true;
}

// ─── BOT START ──────────────────────────
bot.start(ctx => {
  const ref = (ctx.startPayload || '').replace(/^ref_/, '');
  if (ref && ref !== String(ctx.from.id)) {
    config.referrals[ref] = (config.referrals[ref] || 0) + 1;
    saveConfig();
  }
  ctx.reply(`👋 Welcome, ${ctx.from.first_name}!\nUse /menu to begin.`);
});

// ─── MENU ───────────────────────────────
bot.command('menu', ctx => {
  const buttons = [
    [Markup.button.callback('📤 Upload Image', 'UPLOAD')],
    [Markup.button.callback('🔍 Check Link', 'HEALTH')],
    [Markup.button.callback('🕓 Schedule Upload', 'SCHEDULE')],
  ];
  if (ctx.from.id === ADMIN_ID) {
    buttons.push([Markup.button.callback('🛠 Admin Panel', 'ADMIN')]);
  }
  ctx.reply('📋 Menu', Markup.inlineKeyboard(buttons));
});

// ─── IMAGE FLOW ─────────────────────────
const pending = {};
bot.action('UPLOAD', ctx =>
  ctx.editMessageText('📤 Send an image.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'menu')]]))
);

bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  const img = ctx.message.photo.pop();
  const fileInfo = await ctx.telegram.getFile(img.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;

  const outputPath = `./compressed_${Date.now()}.jpg`;
  const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  await sharp(res.data).resize(1280, 1280, { fit: 'inside' }).jpeg().toFile(outputPath);

  pending[ctx.from.id] = { path: outputPath };

  await ctx.replyWithPhoto({ source: outputPath }, {
    caption: `📏 1280×1280px • jpeg`,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', 'CONFIRM')],
      [Markup.button.callback('❌ Cancel', 'CANCEL')],
    ]),
  });
});

bot.action('CANCEL', async ctx => {
  delete pending[ctx.from.id];
  await ctx.deleteMessage();
  ctx.reply('❌ Cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'menu')]]));
});

bot.action('CONFIRM', async ctx => {
  await ctx.editMessageCaption({
    caption: '✅ Confirmed. Choose action:',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Upload Now', 'UPLOAD_NOW')],
      [Markup.button.callback('🕓 Schedule', 'SCHEDULE')],
    ]),
  });
});

bot.action('UPLOAD_NOW', async ctx => {
  const file = pending[ctx.from.id];
  if (!file) return ctx.reply('⚠️ Nothing to upload.');
  const form = new FormData();
  form.append('file', fs.createReadStream(file.path));
  try {
    const res = await axios.post('https://telegra.ph/upload', form, { headers: form.getHeaders() });
    const link = 'https://telegra.ph' + res.data[0].src;
    config.uploads[ctx.from.id] = (config.uploads[ctx.from.id] || []).concat(link);
    config.stats.requests++;
    saveConfig();
    await ctx.reply(`✅ Uploaded: ${link}`, Markup.inlineKeyboard([
      [Markup.button.url('🌐 View', link)],
      [Markup.button.callback('🔙 Back', 'menu')],
    ]));
  } catch {
    await ctx.reply('❌ Upload failed.');
  } finally {
    fs.unlinkSync(file.path);
    delete pending[ctx.from.id];
  }
});

bot.action('SCHEDULE', async ctx => {
  ctx.reply('📅 Send datetime as `YYYY-MM-DD HH:mm` (24h format):', {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu')]]),
  });

  bot.once('text', async tctx => {
    const when = new Date(tctx.message.text.replace(' ', 'T'));
    if (isNaN(when)) return tctx.reply('❌ Invalid datetime format.');

    const file = pending[tctx.from.id];
    if (!file) return tctx.reply('⚠️ Nothing to schedule.');

    schedule.scheduleJob(when, async () => {
      const form = new FormData();
      form.append('file', fs.createReadStream(file.path));
      try {
        const res = await axios.post('https://telegra.ph/upload', form, { headers: form.getHeaders() });
        const link = 'https://telegra.ph' + res.data[0].src;
        config.uploads[tctx.from.id] = (config.uploads[tctx.from.id] || []).concat(link);
        config.stats.requests++;
        saveConfig();
        await tctx.telegram.sendMessage(tctx.chat.id, `✅ Scheduled Upload Done: ${link}`);
      } catch {
        await tctx.telegram.sendMessage(tctx.chat.id, '❌ Upload failed.');
      } finally {
        fs.unlinkSync(file.path);
        delete pending[tctx.from.id];
      }
    });

    await tctx.reply(`⏰ Scheduled for ${when.toLocaleString()}`);
  });
});

// ─── INLINE HEALTH CHECK ────────────────
bot.inlineQuery(async ({ inlineQuery, answerInlineQuery }) => {
  const url = inlineQuery.query.trim();
  if (!url.startsWith('https://telegra.ph/file/')) return answerInlineQuery([], {
    switch_pm_text: 'Start using bot',
    switch_pm_parameter: 'start',
  });

  try {
    const ok = (await axios.head(url)).status === 200;
    return answerInlineQuery([{
      type: 'article',
      id: 'health',
      title: ok ? '🟢 Link OK' : '🔴 Broken Link',
      input_message_content: { message_text: `${ok ? '✔️' : '❌'} ${url}` },
      description: ok ? 'Telegra.ph link is valid' : 'Link seems broken',
      thumb_url: url,
    }]);
  } catch {
    return answerInlineQuery([{
      type: 'article',
      id: 'fail',
      title: '🔴 Invalid Link',
      input_message_content: { message_text: `❌ ${url}` },
      description: 'Could not fetch this link',
    }]);
  }
});

// ─── ADMIN PANEL ────────────────────────
bot.action('ADMIN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply('🛠 Admin Tools', Markup.inlineKeyboard([
    [Markup.button.callback('📊 Stats', 'STATS')],
    [Markup.button.callback('🚫 Banlist', 'BANS')],
    [Markup.button.callback('🎁 Referrals', 'REFS')],
    [Markup.button.callback('🔙 Back', 'menu')],
  ]));
});

bot.action('STATS', ctx => {
  const users = Object.keys(config.stats.users).length;
  ctx.reply(`📊 Total Uploads: ${config.stats.requests}\n👤 Unique Users: ${users}`);
});

bot.action('BANS', ctx => {
  ctx.reply(`🚫 Banned Users:\n${config.banned.join(', ') || 'None'}`);
});

bot.action('REFS', ctx => {
  const refs = Object.entries(config.referrals).map(([id, count]) => `${id}: ${count}`).join('\n') || 'None';
  ctx.reply(`🎁 Referrals:\n${refs}`);
});

// ─── SERVER ─────────────────────────────
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Bot is alive.');
}).listen(PORT, () => console.log(`✅ HTTP server on port ${PORT}`));

// ─── LAUNCH ─────────────────────────────
bot.catch(err => console.error('BOT ERROR:', err));
bot.launch().then(() => console.log('🚀 Bot launched'));
