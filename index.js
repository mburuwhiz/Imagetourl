/**
 * A full-featured Telegram bot with:
 * 📤 Image → Telegra.ph link
 * 🖼️ Thumbnail preview & confirm
 * ⏰ Scheduling
 * 🔍 Link healthcheck (inline/text)
 * 🛠️ Admin panel: stats, bans, referrals, tokens
 * 🚀 Dummy HTTP server (for Render)
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');
const http = require('http');

// --- Bot Setup ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = +process.env.ADMIN_ID;
const CHANNEL = process.env.FORCE_SUB_CHANNEL.replace(/^@/, '');
const BOT_USERNAME = process.env.BOT_USERNAME;
const IS_FREE_MODE = process.env.IS_FREE_MODE === 'true';

// --- Config Handling ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH))
  : {
      channel: CHANNEL,
      banned: [],
      stats: { requests: 0, users: {} },
      referrals: {},
      recoveryTokens: {}
    };
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Cache & Logging ---
const memberCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });
function auditLog(action, ctx) {
  console.log(`[${new Date().toISOString()}] ${action} by ${ctx.from.username || ctx.from.id}`);
}

// --- Helper: Check Subscription & Ban ---
async function ensureSubscribed(ctx) {
  const uid = ctx.from.id;
  if (config.banned.includes(uid)) {
    await ctx.reply('🚫 You are banned.');
    return false;
  }
  if (uid === ADMIN_ID) {
    auditLog('admin bypass subscription', ctx);
    return true;
  }
  if (!memberCache.has(uid)) {
    try {
      const resp = await ctx.telegram.getChatMember(`@${config.channel}`, uid);
      const ok = ['member', 'creator', 'administrator'].includes(resp.status);
      if (!ok) throw new Error('not member');
      memberCache.set(uid, true);
    } catch {
      await ctx.replyWithHTML(
        `🔒 Please join <b>@${config.channel}</b> to use this bot`,
        Markup.inlineKeyboard([
          [
            Markup.button.url('➡️ Join Channel', `https://t.me/${config.channel}`),
            Markup.button.callback('🔄 I Joined', 'CHECK_JOIN')
          ]
        ])
      );
      return false;
    }
  }
  return true;
}

// --- /start with referral tracking ---
bot.start(ctx => {
  const payload = (ctx.startPayload || '').replace(/^ref_/, '');
  if (payload && payload !== String(ctx.from.id)) {
    config.referrals[payload] = (config.referrals[payload] || 0) + 1;
    saveConfig();
  }
  ctx.reply(
    `👋 Hello, ${ctx.from.first_name}!\nUse /menu to begin.\nFree access for 2 months.`
  );
});

// --- Main Menu ---
bot.command('menu', ctx => {
  const kb = [
    [Markup.button.callback('📤 Upload Image', 'UPLOAD')],
    [Markup.button.callback('🔍 Healthcheck Link', 'HEALTH')],
    [Markup.button.callback('🕓 Schedule Publish', 'SCHEDULE')],
    [Markup.button.url('📣 Join Channel', `https://t.me/${config.channel}`)]
  ];
  if (ctx.from.id === ADMIN_ID) kb.push([Markup.button.callback('🛠️ Admin Panel', 'ADMIN')]);
  ctx.reply('🔹 Main Menu', Markup.inlineKeyboard(kb));
});

// --- Inline-mode link healthcheck ---
bot.inlineQuery(async ({ inlineQuery, answerInlineQuery }) => {
  const q = inlineQuery.query.trim();
  if (!q.startsWith('https://telegra.ph/file/'))
    return answerInlineQuery([], { switch_pm_text: 'Use /menu', switch_pm_parameter: 'start' });

  try {
    const ok = (await axios.head(q)).status === 200;
    await answerInlineQuery([
      {
        type: 'article',
        id: 'hc',
        title: ok ? '🟢 OK' : '🔴 Broken',
        input_message_content: { message_text: `${ok ? '✔️' : '❌'} ${q}` },
        description: ok ? 'Link is valid' : 'Link failed',
        thumb_url: q,
        reply_markup: Markup.inlineKeyboard([
          Markup.button.url(ok ? '🌐 Open' : '🔗 Retry', q)
        ])
      }
    ]);
  } catch {
    await answerInlineQuery([
      {
        type: 'article',
        id: 'hc2',
        title: '🔴 Broken',
        input_message_content: { message_text: `❌ ${q}` },
        description: 'Cannot reach link',
        thumb_url: q,
        reply_markup: Markup.inlineKeyboard([
          Markup.button.url('🔗 Open', q)
        ])
      }
    ]);
  }
});

// --- Callback handlers & photo upload flow ---
bot.action('CHECK_JOIN', async ctx => {
  if (await ensureSubscribed(ctx)) ctx.reply('✅ Thanks! Now /menu');
});
bot.action('HEALTH', ctx =>
  ctx.editMessageText('🔍 Send a telegra.ph/file link to check', {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'menu')]])
  })
);

// Scheduling view
const scheduled = {};
bot.action('SCHEDULE', ctx => {
  const jobs = (scheduled[ctx.from.id] || [])
    .map(job => job.nextInvocation().toLocaleString())
    .join('\n') || 'No scheduled jobs';
  ctx.editMessageText(`🕓 Your Scheduled Publishes:\n${jobs}`, {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('📤 New Upload', 'UPLOAD')],
      [Markup.button.callback('🔙 Back', 'menu')]
    ])
  });
});

// Upload flow
const pending = {};
bot.action('UPLOAD', ctx =>
  ctx.editMessageText('📤 Send me an image to convert', {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'menu')]])
  })
);

bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  const photo = ctx.message.photo.slice(-1)[0];
  const file = await ctx.telegram.getFile(photo.file_id);
  pending[ctx.from.id] = { file_path: file.file_path };

  const thumb = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const msg = await ctx.replyWithPhoto({ url: thumb }, {
    reply_markup: Markup.inlineKeyboard([
      Markup.button.callback('✅ Confirm', 'CONFIRM'),
      Markup.button.callback('❌ Cancel', 'CANCEL')
    ])
  });
  pending[ctx.from.id].msg_id = msg.message_id;
});

// Cancel confirmation
bot.action('CANCEL', ctx => {
  delete pending[ctx.from.id];
  ctx.deleteMessage().catch(() => {});
  ctx.reply('❌ Upload canceled.', {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'menu')]])
  });
});

// Confirm image
bot.action('CONFIRM', ctx => {
  ctx.deleteMessage().catch(() => {});
  ctx.reply('✅ Confirmed! Publish now or schedule?', {
    reply_markup: Markup.inlineKeyboard([
      Markup.button.callback('🚀 Now', 'DO_NOW'),
      Markup.button.callback('⏰ Later', 'DO_SCHEDULE'),
      Markup.button.callback('🔙 Back', 'menu')
    ])
  });
});

// Publish immediately
bot.action('DO_NOW', async ctx => {
  const p = pending[ctx.from.id];
  if (!p) return ctx.reply('⚠️ Nothing to publish.');
  await uploadToTelegraph(p.file_path, ctx);
  delete pending[ctx.from.id];
});

// Schedule publication
bot.action('DO_SCHEDULE', ctx => {
  ctx.reply('📅 Send date/time as `YYYY-MM-DD HH:mm`', {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'menu')]])
  });

  bot.once('text', async mctx => {
    const dt = new Date(mctx.message.text.replace(' ', 'T'));
    if (isNaN(dt)) return mctx.reply('❌ Invalid format.');

    const job = schedule.scheduleJob(dt, async () => {
      const p = pending[mctx.from.id];
      if (p) await uploadToTelegraph(p.file_path, mctx);
      delete pending[mctx.from.id];
    });
    scheduled[mctx.from.id] = (scheduled[mctx.from.id] || []).concat(job);
    mctx.reply(`⏰ Scheduled at ${dt.toLocaleString()}`, {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'menu')]])
    });
  });
});

// --- Upload helper with logging ---
async function uploadToTelegraph(file_path, ctx) {
  try {
    config.stats.requests++;
    config.stats.users[ctx.from.id] = (config.stats.users[ctx.from.id] || 0) + 1;
    saveConfig();

    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file_path}`;
    console.log('Fetching image:', url);
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    console.log('Fetched image size:', resp.data.length);

    const form = new FormData();
    form.append('file', resp.data, 'image.jpg');
    const upl = await axios.post('https://telegra.ph/upload', form, {
      headers: form.getHeaders(),
      timeout: 20000
    });
    console.log('Telegraph upload status:', upl.status, upl.data);

    if (upl.status !== 200 || !upl.data[0]?.src) throw new Error('Bad telegraph response');
    const link = `https://telegra.ph${upl.data[0].src}`;

    return ctx.reply(`✅ Published: ${link}`, {
      reply_markup: Markup.inlineKeyboard([
        Markup.button.switchToCurrentChat('📋 Copy Link', link),
        [Markup.button.url('🌐 Open', link)],
        [Markup.button.callback('🔙 Back', 'menu')]
      ])
    });
  } catch (err) {
    console.error('Upload error:', err);
    return ctx.reply('❌ Upload failed. Check logs & try again.');
  }
}

// --- Text handling for inline healthcheck ---
bot.on('text', ctx => {
  const t = ctx.message.text.trim();
  if (t.startsWith('https://telegra.ph/file/')) {
    return bot.handleUpdate({ inline_query: { query: t }, update_id: 0 });
  }
});

// --- Admin Panel & Commands ---
bot.action('ADMIN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized', true);
  ctx.editMessageText('🛠️ Admin Panel', {
    reply_markup: Markup.inlineKeyboard([
      Markup.button.callback('📊 Stats', 'AD_STATS'),
      Markup.button.callback('🚫 Bans', 'AD_BANS'),
      Markup.button.callback('🎁 Referrals', 'AD_REFS'),
      Markup.button.callback('🔑 Tokens', 'AD_TOKENS'),
      Markup.button.callback('🔙 Back', 'menu')
    ])
  });
});
bot.action('AD_STATS', ctx => {
  const total = config.stats.requests;
  const users = Object.keys(config.stats.users).length;
  ctx.reply(`📊 Stats\n- Total: ${total}\n- Users: ${users}`, {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙', 'ADMIN')]])
  });
});
bot.action('AD_BANS', ctx => {
  ctx.reply(`🚫 Banned:\n${config.banned.join(', ') || 'None'}`, {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙', 'ADMIN')]])
  });
});
bot.action('AD_REFS', ctx => {
  const lines = Object.entries(config.referrals).map(([u, c]) => `• ${u}: ${c}`);
  ctx.reply(`🎁 Referrals:\n${lines.join('\n') || 'None'}`, {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙', 'ADMIN')]])
  });
});
bot.action('AD_TOKENS', ctx => {
  ctx.reply('🔑 Manage Tokens', {
    reply_markup: Markup.inlineKeyboard([
      Markup.button.callback('➕ Create', 'AD_NEW'),
      Markup.button.callback('📋 List', 'AD_LIST'),
      Markup.button.callback('🔙 Back', 'ADMIN')
    ])
  });
});
bot.action('AD_NEW', ctx => {
  ctx.reply('Send: `<userId> <days>` to create token');
  bot.once('text', mctx => {
    const [uid, days] = mctx.text.trim().split(' ').map(Number);
    if (!uid || !days) return mctx.reply('❌ Format wrong.');
    const token = Math.random().toString(36).slice(2, 8).toUpperCase();
    config.recoveryTokens[token] = { userId: uid, days };
    saveConfig();
    mctx.reply(`✅ Token: \`${token}\` for ${days} days`, { parse_mode: 'Markdown' });
  });
});
bot.action('AD_LIST', ctx => {
  const lines = Object.entries(config.recoveryTokens)
    .map(([t, v]) => `${t}: ${v.userId} (${v.days}d)`);
  ctx.reply(`🗒 Tokens:\n${lines.join('\n') || 'None'}`, {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙', 'ADMIN')]])
  });
});
bot.command('redeem', ctx => {
  const t = ctx.message.text.split(' ')[1];
  const info = config.recoveryTokens[t];
  if (!info) return ctx.reply('❌ Invalid token.');
  delete config.recoveryTokens[t];
  saveConfig();
  ctx.reply(`✅ Redeemed ${info.days} day(s) for user ${info.userId}`);
});

// --- Global error handler & launch ---
bot.catch(err => console.error('BOT ERROR:', err));
bot.launch().then(() => console.log('🤖 Bot is up and running'));
bot.launch().catch(console.error);

// --- Dummy server for Render ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('🤖 Bot is running!');
}).listen(PORT, () => console.log(`✅ HTTP server on port ${PORT}`));
