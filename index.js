require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const defaultConfig = {
  channel: process.env.FORCE_SUB_CHANNEL.replace(/^@/, ''),
  banned: [],
  stats: { requests: 0 },
  referrals: {},
  uploads: {}
};
let config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH))
  : defaultConfig;
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── ENV & STATE ───────────────────────────────────────────────────────────
const bot      = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNEL  = config.channel;
const BOT_NAME = process.env.BOT_USERNAME; // without @
const IS_FREE  = process.env.IS_FREE_MODE === 'true';
const pending  = {};  // userId → { path }
const cacheTTL = 5 * 60 * 1000;
const memberCache = new Map();

// ─── HELPERS ───────────────────────────────────────────────────────────────
async function ensureSubscribed(ctx) {
  const uid = ctx.from.id;
  if (uid === ADMIN_ID || IS_FREE) return true;
  if (config.banned.includes(uid)) {
    await ctx.reply('🚫 You are banned.');
    return false;
  }
  const last = memberCache.get(uid) || 0;
  if (Date.now() - last > cacheTTL) {
    try {
      const m = await ctx.telegram.getChatMember(`@${CHANNEL}`, uid);
      if (!['member','administrator','creator'].includes(m.status)) throw 0;
      memberCache.set(uid, Date.now());
    } catch {
      await ctx.replyWithHTML(
        `🔒 Please join <b>@${CHANNEL}</b> to use this bot.`,
        Markup.inlineKeyboard([
          [ Markup.button.url('➡️ Join Channel', `https://t.me/${CHANNEL}`), Markup.button.callback('🔄 I Joined','CHECK_JOIN') ]
        ])
      );
      return false;
    }
  }
  return true;
}

function formatBytes(bytes) {
  if (!bytes) return '0 Bytes';
  const k = 1024, sizes = ['Bytes','KB','MB'];
  const i = Math.floor(Math.log(bytes)/Math.log(k));
  return `${(bytes/Math.pow(k,i)).toFixed(2)} ${sizes[i]}`;
}

// ─── BOT FLOW ──────────────────────────────────────────────────────────────
bot.start(ctx => {
  const ref = (ctx.startPayload||'').replace(/^ref_/, '');
  if (ref && ref !== String(ctx.from.id)) {
    config.referrals[ref] = (config.referrals[ref]||0) + 1;
    saveConfig();
  }
  ctx.reply('👋 Welcome! Use /menu', Markup.inlineKeyboard([[ Markup.button.callback('📋 Menu','MENU') ]]));
});

bot.command('menu', ctx => {
  const kb = [
    [ Markup.button.callback('📤 Upload Image','UPLOAD') ],
    [ Markup.button.callback('🔍 Check Link','HEALTH') ]
  ];
  if (ctx.from.id === ADMIN_ID) kb.push([ Markup.button.callback('🛠 Admin','ADMIN') ]);
  ctx.reply('📋 Main Menu', Markup.inlineKeyboard(kb));
});

bot.action('CHECK_JOIN', async ctx => {
  if (await ensureSubscribed(ctx)) ctx.reply('✅ Access granted! Use /menu');
});

// INLINE HEALTHCHECK
bot.inlineQuery(async ({ inlineQuery, answerInlineQuery }) => {
  const q = inlineQuery.query.trim();
  if (!q.startsWith('https://telegra.ph/file/')) {
    return answerInlineQuery([], { switch_pm_text:'Use /menu', switch_pm_parameter:'start' });
  }
  try {
    const ok = (await axios.head(q)).status === 200;
    return answerInlineQuery([{
      type:'article', id:'hc',
      title: ok?'🟢 OK':'🔴 Broken',
      input_message_content:{ message_text:`${ok?'✔️':'❌'} ${q}` },
      description: ok?'Link valid':'Link broken'
    }]);
  } catch {
    return answerInlineQuery([{
      type:'article', id:'hc2',
      title:'🔴 Broken',
      input_message_content:{ message_text:`❌ ${q}` },
      description:'Cannot fetch'
    }]);
  }
});

// HEALTH MENU
bot.action('HEALTH', ctx => {
  ctx.editMessageText('🔍 Send any https://telegra.ph/file/... link to check.', {
    reply_markup: Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back','MENU') ]])
  });
});

// UPLOAD FLOW
bot.action('UPLOAD', ctx => {
  ctx.editMessageText('📤 Send me an image.', {
    reply_markup: Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back','MENU') ]])
  });
});

bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  const p = ctx.message.photo.pop();
  const f = await ctx.telegram.getFile(p.file_id);
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`;

  // Download & compress
  const tmp = path.join(__dirname, `tmp_${ctx.from.id}_${Date.now()}.jpg`);
  const data = await axios.get(url, { responseType:'arraybuffer' }).then(r=>r.data);
  fs.writeFileSync(tmp, data);
  const cmp = tmp.replace('.jpg','_c.jpg');
  await sharp(tmp).resize(1280,1280,{fit:'inside'}).jpeg({quality:80}).toFile(cmp);
  fs.unlinkSync(tmp);

  const stat = fs.statSync(cmp), meta = await sharp(cmp).metadata();
  pending[ctx.from.id] = { path:cmp };

  await ctx.reply(
    `🖼 Image ready to upload\n• ${meta.width}×${meta.height}px\n• ${formatBytes(stat.size)}`,
    Markup.inlineKeyboard([
      [ Markup.button.callback('✅ Confirm Upload','CONFIRM') ],
      [ Markup.button.callback('❌ Cancel','CANCEL') ]
    ])
  );
});

bot.action('CANCEL', async ctx => {
  const f = pending[ctx.from.id];
  if (f && fs.existsSync(f.path)) fs.unlinkSync(f.path);
  delete pending[ctx.from.id];
  ctx.reply('❌ Upload canceled.', Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back','MENU') ]]));
});

// ─── UPDATED CONFIRM HANDLER ───────────────────────────────────────────────
bot.action('CONFIRM', async ctx => {
  const file = pending[ctx.from.id];
  if (!file) return ctx.reply('⚠️ No image found.');

  try {
    // Read entire file into buffer
    const buffer = fs.readFileSync(file.path);

    // Prepare FormData with known length
    const form = new FormData();
    form.append('file', buffer, {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
      knownLength: buffer.length
    });

    // Compute Content-Length
    const length = await new Promise((res, rej) =>
      form.getLength((err, len) => err ? rej(err) : res(len))
    );
    const headers = { ...form.getHeaders(), 'Content-Length': length };

    // Upload
    const uploadRes = await axios.post('https://telegra.ph/upload', form, {
      headers,
      timeout: 20000
    });

    if (!uploadRes.data[0]?.src) {
      throw new Error('Invalid response: ' + JSON.stringify(uploadRes.data));
    }
    const link = 'https://telegra.ph' + uploadRes.data[0].src;

    // Record & reply
    config.uploads[ctx.from.id] = (config.uploads[ctx.from.id]||[]).concat(link);
    config.stats.requests++;
    saveConfig();

    await ctx.reply(
      `✅ Uploaded!\n🔗 ${link}`,
      Markup.inlineKeyboard([
        [ Markup.button.url('🌐 View', link) ],
        [ Markup.button.switchToCurrentChat('📋 Copy Link', link) ],
        [ Markup.button.switchToCurrentChat('✏️ Mention me anywhere', `@${BOT_NAME} ${link}`) ],
        [ Markup.button.callback('🔙 Back','MENU') ]
      ])
    );
  } catch (err) {
    console.error('Upload error:', err.response?.status, err.response?.data || err.message);
    await ctx.reply('❌ Upload failed. Try again later.');
  } finally {
    fs.unlinkSync(file.path);
    delete pending[ctx.from.id];
  }
});

// ADMIN PANEL
bot.action('ADMIN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.editMessageText('🛠 Admin Panel', Markup.inlineKeyboard([
    [ Markup.button.callback('📊 Stats','ASTATS') ],
    [ Markup.button.callback('🚫 Bans','ABANS') ],
    [ Markup.button.callback('🎁 Refs','AREFS') ],
    [ Markup.button.callback('🔙 Back','MENU') ]
  ]));
});
bot.action('ASTATS', ctx => ctx.reply(`📊 Total uploads: ${config.stats.requests}`));
bot.action('ABANS', ctx => ctx.reply(`🚫 Banned:\n${config.banned.join(', ')||'None'}`));
bot.action('AREFS', ctx => {
  const lines = Object.entries(config.referrals).map(([u,c])=>`${u}: ${c}`);
  ctx.reply(`🎁 Referrals:\n${lines.join('\n')||'None'}`);
});

// Dummy server for Render
http.createServer((_,res) => {
  res.writeHead(200); res.end('Bot is alive');
}).listen(process.env.PORT||10000, () => console.log('✅ Server running'));

// Launch bot
bot.catch(e => console.error(e));
bot.launch().then(()=>console.log('Hurrey 🤖 Bot started')).catch(console.error);
