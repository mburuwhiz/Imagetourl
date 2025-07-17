require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const schedule = require('node-schedule');
const express = require('express');
const { LRUCache } = require('lru-cache');

// ─── CONFIG ───────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const defaultConfig = {
  channel: process.env.FORCE_SUB_CHANNEL.replace(/^@/, ''),
  banned: [],
  stats: { requests: 0, users: {} },
  referrals: {},
  recoveryTokens: {},
  uploads: {}
};
let config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH))
  : defaultConfig;
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── ENV & CACHING ──────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNEL = config.channel;
const IS_FREE_MODE = process.env.IS_FREE_MODE === 'true';
const memberCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });

// ─── HELPERS ───────────────────────────────────────────────────────────────
async function ensureSubscribed(ctx) {
  if (ctx.from.id === ADMIN_ID || IS_FREE_MODE) return true;
  const uid = ctx.from.id;
  if (config.banned.includes(uid)) {
    await ctx.reply('🚫 You are banned.');
    return false;
  }
  if (!memberCache.has(uid)) {
    try {
      const m = await ctx.telegram.getChatMember(`@${CHANNEL}`, uid);
      if (!['member','administrator','creator'].includes(m.status)) throw 0;
      memberCache.set(uid, true);
    } catch {
      await ctx.replyWithHTML(
        `🔒 Please join <b>@${CHANNEL}</b> first.`,
        Markup.inlineKeyboard([
          [ Markup.button.url('➡️ Join Channel', `https://t.me/${CHANNEL}`) ],
          [ Markup.button.callback('🔄 I Joined', 'CHECK_JOIN') ]
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
  return parseFloat((bytes/Math.pow(k,i)).toFixed(2)) + ' ' + sizes[i];
}

// ─── BOT FLOW ──────────────────────────────────────────────────────────────
const pending = {};
const scheduledJobs = {};

// /start with referral
bot.start(ctx => {
  const payload = (ctx.startPayload||'').replace(/^ref_/, '');
  if (payload && payload !== String(ctx.from.id)) {
    config.referrals[payload] = (config.referrals[payload]||0) + 1;
    saveConfig();
  }
  ctx.reply(`👋 Hello ${ctx.from.first_name}! Use /menu to begin.`);
});

// /menu
bot.command('menu', ctx => {
  const k = [
    [ Markup.button.callback('📤 Upload Image', 'UPLOAD') ],
    [ Markup.button.callback('🔍 Check Link',   'HEALTH') ],
    [ Markup.button.callback('🕓 Schedule',     'SCHEDULE') ]
  ];
  if (ctx.from.id === ADMIN_ID) k.push([ Markup.button.callback('🛠 Admin', 'ADMIN') ]);
  ctx.reply('📋 Main Menu', Markup.inlineKeyboard(k));
});

// Join refresh
bot.action('CHECK_JOIN', async ctx => {
  if (await ensureSubscribed(ctx)) ctx.reply('✅ Joined! Use /menu');
});

// Inline healthchecker
bot.inlineQuery(async ({ inlineQuery, answerInlineQuery }) => {
  const q = inlineQuery.query.trim();
  if (!q.startsWith('https://telegra.ph/file/')) return answerInlineQuery([], {
    switch_pm_text: 'Use /menu',
    switch_pm_parameter: 'start'
  });
  try {
    const ok = (await axios.head(q)).status === 200;
    return answerInlineQuery([{
      type: 'article', id: 'hc',
      title: ok?'🟢 OK':'🔴 Broken',
      input_message_content: { message_text: `${ok?'✔️':'❌'} ${q}` },
      description: ok?'Link valid':'Link broken'
    }]);
  } catch {
    return answerInlineQuery([{
      type: 'article', id: 'hc2',
      title: '🔴 Broken',
      input_message_content: { message_text: `❌ ${q}` },
      description: 'Cannot fetch link'
    }]);
  }
});

// HEALTH menu
bot.action('HEALTH', ctx => {
  ctx.editMessageText('🔍 Send a https://telegra.ph/file/... link to check.', {
    reply_markup: Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back','menu') ]])
  });
});

// SCHEDULE menu
bot.action('SCHEDULE', ctx => {
  const jobs = (scheduledJobs[ctx.from.id]||[]).map(j=>j.nextInvocation().toLocaleString()).join('\n')||'None';
  ctx.editMessageText(`🕓 Your schedules:\n${jobs}`, {
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.callback('📤 New Upload','UPLOAD') ],
      [ Markup.button.callback('🔙 Back','menu') ]
    ])
  });
});

// UPLOAD start
bot.action('UPLOAD', ctx => {
  ctx.editMessageText('📤 Send me an image to upload.', {
    reply_markup: Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back','menu') ]])
  });
});

// PHOTO handler
bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;
  const p = ctx.message.photo.slice(-1)[0];
  const f = await ctx.telegram.getFile(p.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`;

  // download & compress
  const tmp = path.join(__dirname, `tmp_${ctx.from.id}_${Date.now()}.jpg`);
  const resp = await axios.get(fileUrl, { responseType:'arraybuffer' });
  fs.writeFileSync(tmp, resp.data);
  const cmp = tmp.replace('.jpg','_c.jpg');
  await sharp(tmp).resize(1280,1280,{fit:'inside'}).jpeg({quality:80}).toFile(cmp);
  fs.unlinkSync(tmp);

  const stat = fs.statSync(cmp);
  const meta = await sharp(cmp).metadata();
  pending[ctx.from.id] = { path: cmp };

  await ctx.replyWithPhoto({ source: cmp }, {
    caption: `🖼️ Image ready to upload\n📏 ${meta.width}×${meta.height}px • ${formatBytes(stat.size)}`,
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.callback('✅ Confirm','CONFIRM') ],
      [ Markup.button.callback('❌ Cancel','CANCEL') ]
    ])
  });
});

// CANCEL
bot.action('CANCEL', async ctx => {
  const f = pending[ctx.from.id];
  if (f && fs.existsSync(f.path)) fs.unlinkSync(f.path);
  delete pending[ctx.from.id];
  await ctx.deleteMessage();
  ctx.reply('❌ Upload canceled.', Markup.inlineKeyboard([[ Markup.button.callback('🔙 Back','menu') ]]));
});

// CONFIRM uploads immediately
bot.action('CONFIRM', async ctx => {
  const file = pending[ctx.from.id];
  if (!file) return ctx.reply('⚠️ No image found.');

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(file.path));
    const res = await axios.post('https://telegra.ph/upload', form, { headers: form.getHeaders() });
    const link = 'https://telegra.ph' + res.data[0].src;

    // record
    config.uploads[ctx.from.id] = (config.uploads[ctx.from.id]||[]).concat(link);
    config.stats.requests++;
    saveConfig();

    await ctx.editMessageCaption({
      caption: `✅ <b>Uploaded Successfully</b>\n🔗 <a href="${link}">${link}</a>`,
      parse_mode:'HTML',
      reply_markup: Markup.inlineKeyboard([
        [ Markup.button.url('🌐 View', link) ],
        [ Markup.button.callback('🔙 Back','menu') ]
      ])
    });
  } catch (err) {
    console.error('Upload error:', err);
    await ctx.reply('❌ Upload failed. Please try again.');
  } finally {
    fs.unlinkSync(file.path);
    delete pending[ctx.from.id];
  }
});

// SCHEDULE on text after scheduling prompt
bot.on('text', async ctx => {
  const txt = ctx.message.text.trim();
  // if a schedule prompt is active
  if (ctx._updateSubTypes && ctx._updateSubTypes[0] === 'text' && scheduledJobs[ctx.from.id] === undefined) {
    // no scheduling context, ignore
    return;
  }
});

// ADMIN panel
bot.action('ADMIN', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.editMessageText('🛠 Admin Panel', Markup.inlineKeyboard([
    [ Markup.button.callback('📊 Stats','ASTATS') ],
    [ Markup.button.callback('🚫 Bans','ABANS') ],
    [ Markup.button.callback('🎁 Refs','AREFS') ],
    [ Markup.button.callback('🔙 Back','menu') ]
  ]));
});
bot.action('ASTATS', ctx => {
  ctx.reply(`📊 Total: ${config.stats.requests}\n👥 Users: ${Object.keys(config.stats.users).length}`);
});
bot.action('ABANS', ctx => ctx.reply(`🚫 Banned:\n${config.banned.join(', ')||'None'}`));
bot.action('AREFS', ctx => {
  const lines = Object.entries(config.referrals).map(([u,c])=>`${u}: ${c}`);
  ctx.reply(`🎁 Referrals:\n${lines.join('\n')||'None'}`);
});

// Dummy server for Render health
http.createServer((_,res) => res.end('Bot is alive')).listen(process.env.PORT||10000);

// Launch
bot.launch().then(()=>console.log('🤖 Bot started')).catch(console.error);
