/**
 * A menu-driven Telegram bot that:
 *  - Converts images to Telegra.ph links
 *  - Thumbnail preview + confirmation
 *  - Schedule future publishes
 *  - Link healthcheck (inline & text)
 *  - Fully inline-mode supported
 *  - Navigation via inline buttons (with Back)
 *  - Admin panel (stats, bans, referrals, recovery)
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');

// ─── BOT + ENV ───────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = +process.env.ADMIN_ID;
const CHANNEL = process.env.FORCE_SUB_CHANNEL.replace(/^@/, '');
const BOT_USERNAME = process.env.BOT_USERNAME;
const IS_FREE_MODE = process.env.IS_FREE_MODE === 'true';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH))
  : { channel: CHANNEL, banned: [], stats: { requests: 0, users: {} }, referrals: {}, recoveryTokens: {} };
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

// ─── CACHE & LOGGING ─────────────────────────────────────────────────────────
const memberCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 });
function auditLog(action, ctx) { console.log(`[${new Date().toISOString()}] ${action} by ${ctx.from.username||ctx.from.id}`); }

// ─── UTIL: FORCE ENTER & REFERRAL ────────────────────────────────────────────
async function ensureSubscribed(ctx) {
  const uid = ctx.from.id;
  if (config.banned.includes(uid)) { await ctx.reply('🚫 You are banned.'); return false; }
  if (uid === ADMIN_ID) { auditLog('admin bypass', ctx); return true; }

  if (!memberCache.has(uid)) {
    try {
      const m = await ctx.telegram.getChatMember(`@${config.channel}`, uid);
      const ok = ['member','creator','administrator'].includes(m.status);
      if (!ok) throw 0;
      memberCache.set(uid, true);
    } catch {
      return ctx.replyWithHTML(
        `🔒 Please <b>join @${config.channel}</b> to use this bot`,
        Markup.inlineKeyboard([
          [Markup.button.url('➡️ Join Channel', `https://t.me/${config.channel}`)],
          [Markup.button.callback('🔄 I Joined', 'CHECK_JOIN')]
        ])
      );
    }
  }
  return true;
}

// ─── START & REFERRAL RECORD ─────────────────────────────────────────────────
bot.start(ctx => {
  const payload = (ctx.startPayload||'').replace(/^ref_/, '');
  if (payload && payload !== String(ctx.from.id)) {
    config.referrals[payload] = (config.referrals[payload]||0) + 1; saveConfig();
  }
  ctx.reply(`👋 Hi ${ctx.from.first_name}\nUse /menu to begin. Enjoy free access!`);
});

// ─── MENU ───────────────────────────────────────────────────────────────────
bot.command('menu', ctx => {
  const rows = [
    [Markup.button.callback('📤 Upload Image', 'UPLOAD')],
    [Markup.button.callback('🔍 Healthcheck Link', 'HEALTH')],
    [Markup.button.callback('🕓 Schedule Publish', 'SCHEDULE')],
    [Markup.button.url('📣 Join Channel', `https://t.me/${config.channel}`)]
  ];
  if (ctx.from.id === ADMIN_ID) rows.push([Markup.button.callback('🛠 Admin Panel', 'ADMIN')]);
  ctx.reply('🔹 Main Menu 🔹', Markup.inlineKeyboard(rows));
});

// ─── INLINE-MODE LINK HEALTHCHECK ────────────────────────────────────────────
bot.inlineQuery(async ({ inlineQuery, answerInlineQuery }) => {
  const q = inlineQuery.query.trim();
  if (!q.startsWith('https://telegra.ph/file/')) return answerInlineQuery([], {
    switch_pm_text: 'Use /menu',
    switch_pm_parameter: 'start'
  });

  try {
    const ok = (await axios.head(q)).status === 200;
    await answerInlineQuery([{
      type: 'article', id: 'hc',
      title: ok ? '🟢 OK' : '🔴 Broken',
      input_message_content: { message_text: `${ok?'✔️':'❌'} ${q}` },
      description: ok ? 'Link is valid' : 'Link seems broken',
      thumb_url: q, reply_markup: Markup.inlineKeyboard([
        Markup.button.url(ok?'🌐 Open':'🔗 Retry', q)
      ])
    }]);
  } catch {
    return answerInlineQuery([{
      type: 'article', id: 'hc2',
      title: '🔴 Broken',
      input_message_content: { message_text: `❌ ${q}` },
      description: 'Cannot fetch link',
      thumb_url: q, reply_markup: Markup.inlineKeyboard([
        Markup.button.url('🔗 View', q)
      ])
    }]);
  }
});

// ─── HANDLERS ▼─────────────────────────────────────────────────────────────

// JOIN CHECK
bot.action('CHECK_JOIN', async ctx => {
  if (await ensureSubscribed(ctx)) ctx.reply('✅ You’re now a member! Use /menu');
});

// HEALTH MENU
bot.action('HEALTH', ctx => ctx.editMessageText(
  '🔍 Send me any `https://telegra.ph/file/...` link to check.',
  {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back','menu')]])
  }
));

// SCHEDULE MENU
const scheduled = {};
bot.action('SCHEDULE', ctx => {
  const jobs = (scheduled[ctx.from.id]||[]).map(j=>j.nextInvocation().toLocaleString()).join('\n')||'None';
  ctx.editMessageText(`🕓 Your Schedules:\n${jobs}`, Markup.inlineKeyboard([
    [Markup.button.callback('📤 New Upload','UPLOAD')],
    [Markup.button.callback('🔙 Back','menu')]
  ]));
});

// UPLOAD MENU + IMAGE FLOW
const pending = {};
bot.action('UPLOAD', ctx => ctx.editMessageText(
  '📤 Send an image to convert:',
  Markup.inlineKeyboard([[Markup.button.callback('🔙 Back','menu')]])
));

bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  const p = ctx.message.photo.slice(-1)[0];
  const f = await ctx.telegram.getFile(p.file_id);

  pending[ctx.from.id] = { file_id: p.file_id, file_path: f.file_path };
  const thumb = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`;

  const msg = await ctx.replyWithPhoto({url:thumb}, Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm','CONFIRM')],
    [Markup.button.callback('❌ Cancel','CANCEL')]
  ]));
  pending[ctx.from.id].msg_id = msg.message_id;
});

bot.action('CANCEL', ctx => {
  delete pending[ctx.from.id];
  ctx.deleteMessage();
  ctx.reply('❌ Upload canceled.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Back','menu')]]));
});

bot.action('CONFIRM', ctx => {
  ctx.deleteMessage();
  ctx.reply('✅ Confirmed! Publish now or schedule?', Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Now','DO_NOW')],
    [Markup.button.callback('⏰ Later','DO_SCHEDULE')],
    [Markup.button.callback('🔙 Back','menu')]
  ]));
});

bot.action('DO_NOW', async ctx => {
  const p = pending[ctx.from.id];
  if (!p) return ctx.reply('⚠️ No pending image.');
  await uploadToTelegraph(p.file_path, ctx);
  delete pending[ctx.from.id];
});

bot.action('DO_SCHEDULE', ctx => {
  ctx.reply('📅 Send date/time as `YYYY-MM-DD HH:mm`:', {
    parse_mode:'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu')]])
  });

  bot.once('text', async mctx => {
    const dt = new Date(mctx.message.text.replace(' ', 'T'));
    if (isNaN(dt)) return mctx.reply('❌ Bad format.');

    const job = schedule.scheduleJob(dt, async () => {
      const p = pending[mctx.from.id];
      if (p) await uploadToTelegraph(p.file_path, mctx);
      delete pending[mctx.from.id];
    });
    scheduled[mctx.from.id] = (scheduled[mctx.from.id]||[]).concat(job);
    mctx.reply(`⏰ Scheduled at ${dt.toLocaleString()}`, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back','menu')]
    ]));
  });
});

// UPLOAD HELPER
async function uploadToTelegraph(file_path, ctx) {
  try {
    config.stats.requests++;
    config.stats.users[ctx.from.id] = (config.stats.users[ctx.from.id]||0) + 1;
    saveConfig();

    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file_path}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    const form = new FormData();
    form.append('file', resp.data, 'image.jpg');

    const upl = await axios.post('https://telegra.ph/upload', form, { headers: form.getHeaders() });
    const link = `https://telegra.ph${upl.data[0].src}`;

    return ctx.reply(`✅ Published: ${link}`, Markup.inlineKeyboard([
      Markup.button.switchToCurrentChat('📋 Copy Link', link),
      [Markup.button.url('🌐 Open', link)],
      [Markup.button.callback('🔙 Back','menu')]
    ]));
  } catch {
    ctx.reply('❌ Upload failed.');
  }
}

// HANDLE RAW TEXT FOR HEALTHCHECK & REDIRECTS
bot.on('text', ctx => {
  const t = ctx.message.text.trim();
  if (t.startsWith('https://telegra.ph/file/')) {
    return bot.handleUpdate({inline_query:{query:t},update_id:0});
  }
});

// ─── ADMIN PANEL ────────────────────────────────────────────────────────────
bot.action('ADMIN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Nope', true);
  ctx.editMessageText('🛠 Admin Panel', Markup.inlineKeyboard([
    [Markup.button.callback('📊 Stats','AD_STATS')],
    [Markup.button.callback('🚫 Bans','AD_BANS')],
    [Markup.button.callback('🎁 Referrals','AD_REFS')],
    [Markup.button.callback('🔑 Recovery','AD_TOKENS')],
    [Markup.button.callback('🔙 Back','menu')]
  ]));
});

bot.action('AD_STATS', ctx => {
  const total = config.stats.requests;
  const users = Object.keys(config.stats.users).length;
  ctx.reply(`📊 Stats\n• Uploads: ${total}\n• Unique Users: ${users}`, Markup.inlineKeyboard([[Markup.button.callback('🔙','ADMIN')]]));
});

bot.action('AD_BANS', ctx => {
  ctx.reply(`🚫 Banned: ${config.banned.join(', ')||'None'}`, Markup.inlineKeyboard([[Markup.button.callback('🔙','ADMIN')]]));
});

bot.action('AD_REFS', ctx => {
  const lines = Object.entries(config.referrals).map(([u,c])=>`${u}: ${c}`);
  ctx.reply(`🎁 Referrals\n${lines.join('\n')||'None'}`, Markup.inlineKeyboard([[Markup.button.callback('🔙','ADMIN')]]));
});

bot.action('AD_TOKENS', ctx => {
  ctx.reply('🔑 Tokens', Markup.inlineKeyboard([
    [Markup.button.callback('➕ Create','AD_NEW')],
    [Markup.button.callback('📋 List','AD_LIST')],
    [Markup.button.callback('🔙','ADMIN')]
  ]));
});

bot.action('AD_NEW', ctx => {
  ctx.reply('Reply `userId days` to create token:');
  bot.once('text', mctx => {
    const [uid, days] = mctx.message.text.trim().split(' ').map(Number);
    if (!uid||!days) return mctx.reply('Bad format.');
    const tk = Math.random().toString(36).slice(2,8).toUpperCase();
    config.recoveryTokens[tk] = { userId: uid, days };
    saveConfig();
    mctx.reply(`Token: \`${tk}\` for ${days}d`, {parse_mode:'Markdown'});
  });
});

bot.action('AD_LIST', ctx => {
  const lines = Object.entries(config.recoveryTokens).map(([t,v])=>`${t}: ${v.userId} (${v.days}d)`);
  ctx.reply(`🗒 Tokens\n${lines.join('\n')||'No tokens'}`, Markup.inlineKeyboard([[Markup.button.callback('🔙','ADMIN')]]));
});

// ─── USER REDEEM ───────────────────────────────────────────────────────────
bot.command('redeem', ctx => {
  const t = ctx.message.text.split(' ')[1];
  const info = config.recoveryTokens[t];
  if (!info) return ctx.reply('❌ Invalid token.');
  delete config.recoveryTokens[t];
  saveConfig();
  ctx.reply(`✅ Redeemed ${info.days} days for user ${info.userId}`);
});

// ─── ERROR & LAUNCH ─────────────────────────────────────────────────────────
bot.catch(err => console.error('BOT ERR', err));
bot.launch().then(()=>console.log('🤖 Bot started'));
