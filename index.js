/**
 * index.js
 * A menu‑driven Telegram bot that:
 *  - Converts images to Telegra.ph links
 *  - Shows thumbnail preview & confirmation
 *  - Schedules future publishes
 *  - Health‑checks Telegraph URLs (inline & text)
 *  - Fully inline‑mode widget support
 *  - Inline menu navigation with back buttons
 *  - Admin panel: stats, bans, referrals, recovery tokens
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const LRU = require('lru-cache');

// ─── Environment & Initialization ──────────────────────────────────────────
const bot          = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL      = process.env.FORCE_SUB_CHANNEL.replace(/^@/, '');
const ADMIN_ID     = Number(process.env.ADMIN_ID);
const BOT_USERNAME = process.env.BOT_USERNAME;

// ─── Config Management ─────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  channel: CHANNEL,
  banned: [],
  stats: { requests: 0, users: {} },
  referrals: {},        // payload → count
  recoveryTokens: {}    // token → { userId, days }
};
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH)); }
  catch(e){ /* ignore malformed */ }
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

// ─── Caching & Audit Logging ───────────────────────────────────────────────
const memberCache = new LRU({ max: 500, ttl: 1000 * 60 * 5 });
const auditLog = (action, ctx) =>
  console.log(`[${new Date().toISOString()}] ${action} by ${ctx.from.username||ctx.from.id}`);

// ─── Utility: Force‑Subscribe & Role Check ─────────────────────────────────
async function ensureSubscribed(ctx) {
  const uid = ctx.from.id;
  if (config.banned.includes(uid)) {
    await ctx.reply('🚫 You are banned from using this bot.');
    return false;
  }
  if (uid === ADMIN_ID) { auditLog('admin bypass', ctx); return true; }

  let status = memberCache.get(uid);
  if (!status) {
    try {
      const m = await ctx.telegram.getChatMember(`@${config.channel}`, uid);
      status = m.status;
      memberCache.set(uid, status);
    } catch {
      await ctx.reply('⚠️ Please add me to your channel and grant “Read Members” permission.');
      return false;
    }
  }
  if (['creator','administrator','member'].includes(status)) {
    auditLog(`subscribed as ${status}`, ctx);
    return true;
  }

  // Prompt to join
  const border = [
    '╭' + '─'.repeat(28) + '╮',
    '│   🔒 Premium Content 🔒   │',
    '╰' + '─'.repeat(28) + '╯'
  ].join('\n');
  const kb = Markup.inlineKeyboard([
    Markup.button.url('➡️ Join Channel', `https://t.me/${config.channel}`),
    Markup.button.callback('🔄 Refresh', 'MENU')
  ], { columns: 2 });
  await ctx.replyWithHTML(
    `<pre>${border}</pre>\n\n⚠️ <b>Please join @${config.channel} first!</b>`, kb
  );
  return false;
}

// ─── Referral Tracking & /start ────────────────────────────────────────────
bot.start(async ctx => {
  const payload = (ctx.startPayload||'').replace(/^ref_/, '');
  if (payload && payload !== String(ctx.from.id)) {
    config.referrals[payload] = (config.referrals[payload]||0) + 1;
    saveConfig();
  }
  await ctx.reply(
    `👋 Hello, ${ctx.from.first_name}!\nUse /menu to start. Free for next 2 months!`
  );
});

// ─── /menu: Main Inline Menu ───────────────────────────────────────────────
bot.command('menu', ctx => {
  const rows = [
    [ Markup.button.callback('📤 Upload Image',     'MENU_UPLOAD') ],
    [ Markup.button.callback('🔍 Check Link',       'MENU_CHECK') ],
    [ Markup.button.callback('🕓 Schedule Publish', 'MENU_SCHEDULE') ],
    [ Markup.button.url    ('📣 Join Channel',     `https://t.me/${config.channel}`) ]
  ];
  if (ctx.from.id === ADMIN_ID) {
    rows.push([ Markup.button.callback('🛠 Admin Panel', 'ADMIN_MENU') ]);
  }
  ctx.reply('🔹 Main Menu 🔹', Markup.inlineKeyboard(rows));
});

// ─── Inline‑Mode Healthchecker ─────────────────────────────────────────────
bot.inlineQuery(async ({ inlineQuery, answerInlineQuery }) => {
  const q = inlineQuery.query.trim();
  if (!q.startsWith('https://telegra.ph/file/')) {
    return answerInlineQuery([], {
      switch_pm_text: 'Use /menu for commands',
      switch_pm_parameter: 'start'
    });
  }
  try {
    const res = await axios.head(q);
    const ok = res.status === 200;
    await answerInlineQuery([{
      type: 'article',
      id:   'health',
      title: ok ? '🟢 Link OK' : '🔴 Link Broken',
      input_message_content: { message_text: `${ok?'✔️':'❌'} ${q}` },
      description: ok ? 'File reachable' : 'Failed to fetch',
      reply_markup: Markup.inlineKeyboard([
        Markup.button.url(ok ? '🌐 Open' : '🔗 Retry', q)
      ])
    }]);
  } catch {
    await answerInlineQuery([{
      type: 'article',
      id:   'health2',
      title: '🔴 Link Broken',
      input_message_content: { message_text: `❌ ${q}` },
      description: 'Unable to reach',
      reply_markup: Markup.inlineKeyboard([
        Markup.button.url('🔗 View', q)
      ])
    }]);
  }
});

// ─── Menu: Link Healthchecker ──────────────────────────────────────────────
bot.action('MENU_CHECK', ctx => {
  ctx.editMessageText(
    '🔍 Send any `https://telegra.ph/file/...` URL to check its status.',
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [ Markup.button.callback('🔙 Back', 'MENU') ]
      ])
    }
  );
});
bot.on('text', ctx => {
  const t = ctx.message.text.trim();
  if (t.startsWith('https://telegra.ph/file/')) {
    // reuse inline-mode handler
    return bot.handleUpdate({ inline_query:{query:t}, update_id:0 });
  }
});

// ─── Upload → Preview → Confirm Flow ───────────────────────────────────────
const pending = {};  // userId → { file_id, file_path }
bot.action('MENU_UPLOAD', ctx => {
  ctx.editMessageText(
    '📤 Please send the image you want to convert.',
    Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back', 'MENU') ]])
  );
});
bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  const photo = ctx.message.photo.slice(-1)[0];
  const f = await ctx.telegram.getFile(photo.file_id);
  pending[ctx.from.id] = { file_id: photo.file_id, file_path: f.file_path };

  // Send thumbnail preview
  const thumbUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`;
  const msg = await ctx.replyWithPhoto(
    { url: thumbUrl },
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Confirm', 'CONFIRM_UPLOAD'),
      Markup.button.callback('❌ Cancel',  'CANCEL_UPLOAD')
    ])
  );
  pending[ctx.from.id].preview_msg_id = msg.message_id;
});
bot.action('CANCEL_UPLOAD', ctx => {
  delete pending[ctx.from.id];
  ctx.deleteMessage();
  ctx.reply('❌ Upload canceled.', Markup.inlineKeyboard([
    Markup.button.callback('🔙 Back', 'MENU')
  ]));
});
bot.action('CONFIRM_UPLOAD', ctx => {
  ctx.deleteMessage();
  ctx.reply('✅ Confirmed! Publish now or schedule later?', Markup.inlineKeyboard([
    Markup.button.callback('🚀 Now',      'PUBLISH_NOW'),
    Markup.button.callback('⏰ Schedule','PUBLISH_SCHEDULE'),
    Markup.button.callback('🔙 Back',     'MENU')
  ]));
});

// Immediate publish
bot.action('PUBLISH_NOW', async ctx => {
  const p = pending[ctx.from.id];
  if (!p) return ctx.reply('⚠️ No pending upload.');
  await publishToTelegraph(p.file_path, ctx);
  delete pending[ctx.from.id];
});

// Scheduled publish
const scheduledJobs = {}; // userId → [ jobs ]
bot.action('PUBLISH_SCHEDULE', ctx => {
  ctx.reply('⏰ Send desired date & time as `YYYY-MM-DD HH:mm` (24h):', {
    parse_mode:'Markdown',
    ...Markup.inlineKeyboard([[ Markup.button.callback('❌ Cancel','MENU') ]])
  });
  bot.once('text', async mctx => {
    const dt = new Date(mctx.message.text.replace(' ','T'));
    if (isNaN(dt)) return mctx.reply('❌ Invalid date format.');
    const job = schedule.scheduleJob(dt, async () => {
      const pp = pending[mctx.from.id];
      if (pp) {
        await publishToTelegraph(pp.file_path, mctx);
        delete pending[mctx.from.id];
      }
    });
    scheduledJobs[mctx.from.id] = (scheduledJobs[mctx.from.id]||[]).concat(job);
    mctx.reply(`⏰ Scheduled for ${dt}`, Markup.inlineKeyboard([
      Markup.button.callback('🔙 Back','MENU')
    ]));
  });
});

// Helper: Publish to Telegra.ph
async function publishToTelegraph(file_path, ctx) {
  try {
    // Analytics
    const uid = ctx.from.id;
    config.stats.requests++;
    config.stats.users[uid] = (config.stats.users[uid]||0) + 1;
    saveConfig();

    // Download & upload
    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file_path}`;
    const resp = await axios.get(url, { responseType:'arraybuffer' });
    const form = new FormData();
    form.append('file', resp.data, 'image.jpg');
    const upl = await axios.post('https://telegra.ph/upload', form, {
      headers: form.getHeaders()
    });
    const link = `https://telegra.ph${upl.data[0].src}`;

    // Reply with link & buttons
    await ctx.reply(`✅ Published: ${link}`, Markup.inlineKeyboard([
      Markup.button.switchToCurrentChat('📋 Copy Link', link),
      Markup.button.url('🌐 Open', link),
      Markup.button.callback('🔙 Back', 'MENU')
    ]));
  } catch {
    await ctx.reply('❌ Upload failed. Please try again later.');
  }
}

// ─── Schedule Menu (View & manage) ────────────────────────────────────────
bot.action('MENU_SCHEDULE', ctx => {
  const jobs = scheduledJobs[ctx.from.id] || [];
  const lines = jobs.length
    ? jobs.map((j,i) => `${i+1}. ${j.nextInvocation().toString()}`).join('\n')
    : 'No schedules.';
  ctx.editMessageText(`🕓 Your Scheduled Publishes:\n\n${lines}`, Markup.inlineKeyboard([
    [ Markup.button.callback('📤 New Upload','MENU_UPLOAD') ],
    [ Markup.button.callback('🔙 Back','MENU') ]
  ]));
});

// ─── Admin Panel ───────────────────────────────────────────────────────────
bot.action('ADMIN_MENU', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Forbidden', true);
  const rows = [
    [ Markup.button.callback('📊 Stats',       'ADMIN_STATS') ],
    [ Markup.button.callback('🚫 Banned List', 'ADMIN_BANNED') ],
    [ Markup.button.callback('⬆️ Ban User',    'ADMIN_BAN') ],
    [ Markup.button.callback('⬇️ Unban User',  'ADMIN_UNBAN') ],
    [ Markup.button.callback('🎁 Referrals',   'ADMIN_REFERRALS') ],
    [ Markup.button.callback('🔑 Recovery',    'ADMIN_RECOVERY') ]
  ];
  rows.push([ Markup.button.callback('🔙 Back','MENU') ]);
  ctx.editMessageText('🛠 Admin Panel', Markup.inlineKeyboard(rows));
});

// Admin: Stats
bot.action('ADMIN_STATS', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const total  = config.stats.requests;
  const unique = Object.keys(config.stats.users).length;
  ctx.reply(`📊 Usage Stats\n• Total uploads: ${total}\n• Unique users: ${unique}`, Markup.inlineKeyboard([
    Markup.button.callback('🔙 Back','ADMIN_MENU')
  ]));
});

// Admin: Banned list
bot.action('ADMIN_BANNED', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const list = config.banned.length ? config.banned.join(', ') : 'None';
  ctx.reply(`🚫 Banned Users: ${list}`, Markup.inlineKeyboard([
    Markup.button.callback('🔙 Back','ADMIN_MENU')
  ]));
});

// Admin: Ban User
bot.action('ADMIN_BAN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply('🔒 Reply with user ID to ban:');
  bot.once('text', mctx => {
    const id = Number(mctx.message.text.trim());
    if (id) {
      config.banned.push(id);
      saveConfig();
      mctx.reply(`🚫 Banned user ${id}`);
    }
  });
});

// Admin: Unban User
bot.action('ADMIN_UNBAN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply('🔓 Reply with user ID to unban:');
  bot.once('text', mctx => {
    const id = Number(mctx.message.text.trim());
    config.banned = config.banned.filter(x => x !== id);
    saveConfig();
    mctx.reply(`✅ Unbanned user ${id}`);
  });
});

// Admin: Referrals
bot.action('ADMIN_REFERRALS', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const lines = Object.entries(config.referrals)
    .map(([u,c]) => `${u}: ${c}`)
    .slice(0, 50);
  const text = `🎁 Referrals\n${lines.length?lines.join('\n'):'None yet'}`;
  ctx.reply(text, Markup.inlineKeyboard([
    Markup.button.callback('🔙 Back','ADMIN_MENU')
  ]));
});

// Admin: Recovery Tokens
bot.action('ADMIN_RECOVERY', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const rows = [
    [ Markup.button.callback('➕ Generate', 'ADMIN_GEN_TOKEN') ],
    [ Markup.button.callback('📋 List',     'ADMIN_LIST_TOKENS') ],
    [ Markup.button.callback('🔙 Back',     'ADMIN_MENU') ]
  ];
  ctx.reply('🔑 Recovery Tokens', Markup.inlineKeyboard(rows));
});
bot.action('ADMIN_GEN_TOKEN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply('✏️ Reply with `<userId> <days>`:');
  bot.once('text', mctx => {
    const [uid, days] = mctx.message.text.trim().split(' ').map(Number);
    if (!uid || !days) return mctx.reply('Invalid format.');
    const token = Math.random().toString(36).substr(2,8).toUpperCase();
    config.recoveryTokens[token] = { userId: uid, days };
    saveConfig();
    mctx.reply(`Generated token: \`${token}\` for ${days} days`, { parse_mode:'Markdown' });
  });
});
bot.action('ADMIN_LIST_TOKENS', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const lines = Object.entries(config.recoveryTokens)
    .map(([t,v]) => `${t} → ${v.userId} for ${v.days}d`);
  ctx.reply(
    `🔑 Recovery Tokens\n${lines.length?lines.join('\n'):'None'}`,
    Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back','ADMIN_MENU') ]])
  );
});

// User: /redeem <token>
bot.command('redeem', ctx => {
  const token = ctx.message.text.split(' ')[1];
  const info = config.recoveryTokens[token];
  if (!info) return ctx.reply('❌ Invalid token.');
  const expires = new Date();
  expires.setDate(expires.getDate() + info.days);
  // place logic here to grant premium if implemented
  delete config.recoveryTokens[token];
  saveConfig();
  ctx.reply(`✅ Redeemed! Enjoy ${info.days} days until ${expires.toDateString()}`);
});

// ─── Launch & Graceful Shutdown ─────────────────────────────────────────────
bot.launch().then(() => console.log('🤖 Bot started')).catch(console.error);
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
