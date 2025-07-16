require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { LRUCache } = require('lru-cache');
const sharp = require('sharp');

// --- Bot Setup ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNEL = process.env.FORCE_SUB_CHANNEL.replace(/^@/, '');
const IS_FREE_MODE = process.env.IS_FREE_MODE === 'true';

// --- Config & Persistence ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH))
  : { channel: CHANNEL, banned: [], stats: { requests: 0, users: {} }, referrals: {}, recoveryTokens: {} };
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

// --- Cache and Utilities ---
const memberCache = new LRUCache({ max: 500, ttl: 300_000 });
async function ensureSubscribed(ctx) {
  const uid = ctx.from.id;
  if (uid === ADMIN_ID) return true;
  if (config.banned.includes(uid)) {
    await ctx.reply('🚫 You are banned.');
    return false;
  }
  if (!memberCache.has(uid)) {
    try {
      const m = await ctx.telegram.getChatMember(`@${CHANNEL}`, uid);
      if (!['member', 'administrator', 'creator'].includes(m.status)) throw new Error();
      memberCache.set(uid, true);
    } catch {
      await ctx.replyWithHTML(
        `🔒 Please join <b>@${CHANNEL}</b>`,
        Markup.inlineKeyboard([
          [Markup.button.url('➡️ Join', `https://t.me/${CHANNEL}`), Markup.button.callback('🔄 I Joined', 'CHECK_JOIN')]
        ])
      );
      return false;
    }
  }
  return true;
}

// --- Telegraph Upload Helper ---
async function uploadToTelegraph(filePath, ctx) {
  try {
    config.stats.requests++;
    config.stats.users[ctx.from.id] = (config.stats.users[ctx.from.id] || 0) + 1;
    saveConfig();

    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`;
    const imgBuffer = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 }).then(r => r.data);

    const form = new FormData();
    form.append('file', imgBuffer, 'image.jpg');
    const resp = await axios.post('https://telegra.ph/upload', form, { headers: form.getHeaders(), timeout: 20000 });

    const link = `https://telegra.ph${resp.data[0].src}`;
    return ctx.reply(`✅ Published: ${link}`, {
      reply_markup: Markup.inlineKeyboard([
        Markup.button.url('🌐 Open', link),
        Markup.button.switchToCurrentChat('📋 Copy Link', link),
        Markup.button.callback('🔙 Back', 'MENU')
      ])
    });
  } catch (e) {
    console.error('Upload error', e);
    return ctx.reply('❌ Upload failed. Please try again.');
  }
}

// --- Main Flow ---
const pending = {};
const scheduledJobs = {};

bot.start(ctx => {
  const payload = (ctx.startPayload || '').replace(/^ref_/, '');
  if (payload && payload !== String(ctx.from.id)) {
    config.referrals[payload] = (config.referrals[payload] || 0) + 1;
    saveConfig();
  }
  ctx.reply(`👋 Hello ${ctx.from.first_name}! Use /menu`);
});

bot.command('menu', ctx => {
  const kb = [
    [Markup.button.callback('📤 Upload Image', 'UPLOAD')],
    [Markup.button.callback('🔁 Re-upload Last', 'REUPLOAD')],
    [Markup.button.callback('🔍 Link Checker', 'CHECK')],
    [Markup.button.callback('🕓 Schedule Post', 'SCHEDULE')],
    [Markup.button.url('📣 Join Channel', `https://t.me/${CHANNEL}`)]
  ];
  if (ctx.from.id === ADMIN_ID) {
    kb.push([Markup.button.callback('🛠 Admin', 'ADMIN')]);
  }
  ctx.reply('🔹 Main Menu', Markup.inlineKeyboard(kb));
});

// --- Join Logic ---
bot.action('CHECK_JOIN', async ctx => {
  if (await ensureSubscribed(ctx)) ctx.reply('✅ You joined! Use /menu');
});

// --- Upload Workflow ---
bot.action('UPLOAD', ctx => ctx.editMessageText('📤 Send an image:', Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'MENU')]])));
bot.on('photo', async ctx => {
  if (!(await ensureSubscribed(ctx))) return;
  const photo = ctx.message.photo.pop();
  const file = await ctx.telegram.getFile(photo.file_id);
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const buffer = await axios.get(url, { responseType: 'arraybuffer' }).then(r => r.data);
  const meta = await sharp(buffer).metadata();

  const caption = ctx.message.caption || 'Image ready to upload';
  pending[ctx.from.id] = { filePath: file.file_path, meta, caption };

  await ctx.replyWithPhoto({ url }, {
    caption: `${caption}\n📏 ${meta.width}×${meta.height}px • ${meta.format}`,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', 'CONFIRM'), Markup.button.callback('❌ Cancel', 'CANCEL')]
    ])
  });
});

bot.action('CANCEL', ctx => {
  delete pending[ctx.from.id];
  ctx.deleteMessage().catch(() => {});
  ctx.reply('❌ Cancelled', Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'MENU')]]));
});

bot.action('CONFIRM', ctx => {
  ctx.deleteMessage().catch(() => {});
  ctx.reply('✅ Confirmed! Publish now or schedule?', Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Now', 'NOW'), Markup.button.callback('⏰ Later', 'LATER')],
    [Markup.button.callback('🔙 Back', 'MENU')]
  ]));
});

// Immediate publish
bot.action('NOW', async ctx => {
  const p = pending[ctx.from.id];
  if (!p) return ctx.reply('⚠️ No pending image');
  await uploadToTelegraph(p.filePath, ctx);
  delete pending[ctx.from.id];
});

// Schedule publish
bot.action('LATER', ctx => {
  ctx.reply('📅 Provide date/time (YYYY-MM-DD HH:mm):', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','MENU')]]));
  bot.once('text', async mctx => {
    const dt = new Date(mctx.text.replace(' ', 'T'));
    if (isNaN(dt)) return mctx.reply('❌ Invalid date');
    const p = pending[mctx.from.id];
    const job = schedule.scheduleJob(dt, () => uploadToTelegraph(p.filePath, mctx));
    scheduledJobs[mctx.from.id] = [...(scheduledJobs[mctx.from.id] || []), job];

    // Auto-expiry after 24h
    setTimeout(() => {
      if (pending[mctx.from.id]) {
        delete pending[mctx.from.id];
        mctx.telegram.sendMessage(ctx.from.id, '⚠️ Scheduled upload expired.');
      }
    }, 24 * 60 * 60 * 1000);

    delete pending[mctx.from.id];
    mctx.reply(`✅ Scheduled for ${dt.toLocaleString()}`);
  });
});

// Re-upload last
bot.action('REUPLOAD', async ctx => {
  const p = pending[ctx.from.id];
  if (!p) return ctx.reply('⚠️ No last image');
  await uploadToTelegraph(p.filePath, ctx);
});

// List schedules
bot.command('schedules', ctx => {
  const jobs = scheduledJobs[ctx.from.id] || [];
  const list = jobs.length ? jobs.map(j => j.nextInvocation().toLocaleString()).join('\n') : 'None';
  ctx.reply(`🗓 Your scheduled posts:\n${list}`);
});

// Link checker
bot.action('CHECK', ctx => ctx.editMessageText('🔍 Send a telegra.ph/file link', Markup.inlineKeyboard([[Markup.button.callback('🔙 Back','MENU')]])));
bot.on('text', async ctx => {
  const t = ctx.message.text.trim();
  if (t.startsWith('https://telegra.ph/file/')) {
    try {
      const ok = (await axios.head(t)).status === 200;
      return ctx.reply(ok ? '🟢 Valid link!' : '🔴 Broken link.');
    } catch {
      return ctx.reply('🔴 Cannot reach link.');
    }
  }
});

// --- Admin Panel ---
bot.action('ADMIN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized', true);
  ctx.editMessageText('🛠 Admin Panel', Markup.inlineKeyboard([
    [Markup.button.callback('📊 Stats','ASTATS')],
    [Markup.button.callback('🚫 Banned','ABAN')],
    [Markup.button.callback('🎁 Referrals','AREF')],
    [Markup.button.callback('🔑 Tokens','ATOK')],
    [Markup.button.callback('♻️ Reset Stats','ARESET')],
    [Markup.button.callback('🔙 Back','MENU')]
  ]));
});

bot.action('ASTATS', ctx => {
  const total = config.stats.requests;
  const uniq = Object.keys(config.stats.users).length;
  ctx.reply(`📊 Total Uploads: ${total}\n👥 Unique Users: ${uniq}`);
});

bot.action('ARESET', ctx => {
  config.stats = { requests: 0, users: {} };
  saveConfig();
  ctx.reply('♻️ Stats reset.');
});

// View bans
bot.action('ABAN', ctx => {
  const banned = config.banned || [];
  const text = banned.length
    ? banned.map(u => `<code>${u}</code>`).join('\n')
    : 'No banned users';
  ctx.replyWithHTML(`🚫 Banned users:\n${text}`);
});

// /ban command
bot.command('ban', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const uid = parseInt(ctx.message.text.split(' ')[1]);
  if (!uid) return ctx.reply('❌ Usage: /ban [userId]');
  config.banned.push(uid);
  saveConfig();
  ctx.reply(`✅ Banned <code>${uid}</code>`);
});

// Referrals view
bot.action('AREF', ctx => {
  const ref = Object.entries(config.referrals);
  const text = ref.length
    ? ref.map(([u,c])=>`<code>${u}</code>: ${c}`).join('\n')
    : 'No referrals';
  ctx.replyWithHTML(`🎁 Referrals:\n${text}`);
});

// Tokens view
bot.action('ATOK', ctx => {
  const tokens = Object.entries(config.recoveryTokens || {});
  const text = tokens.length
    ? tokens.map(([t,v])=>`${t}: <code>${v.userId}</code> (${v.days}d)`).join('\n')
    : 'No recovery tokens';
  ctx.replyWithHTML(`🔐 Recovery Tokens:\n${text}`);
});

// --- Error Logging ---
bot.catch(err => console.error(err));

// --- Webhook Server Setup ---
const app = express();
const webhookPath = `/bot${process.env.BOT_TOKEN}`;
bot.telegram.setWebhook((process.env.RENDER_EXTERNAL_URL || '') + webhookPath);
app.use(bot.webhookCallback(webhookPath));
app.get('/', (_, res) => res.send('✅ Bot running'));
app.listen(process.env.PORT || 3000, () => console.log('Webhook listening'));
