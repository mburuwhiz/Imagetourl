require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const LRU = require('lru-cache');

// Load environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, '') || '';
const ADMINS = process.env.ADMINS
  ? process.env.ADMINS.split(',').map(id => Number(id.trim()))
  : [];

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Load or initialize config
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH));
  } catch {
    config = { channel: process.env.CHANNEL_USERNAME, banned: [], stats: { requests: 0, users: {} } };
  }
} else {
  config = { channel: process.env.CHANNEL_USERNAME, banned: [], stats: { requests: 0, users: {} } };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Cache for membership checks (TTL 5 minutes)
const memberCache = new LRU({ max: 500, ttl: 1000 * 60 * 5 });

// Persist config helper
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Audit logging
function auditLog(action, ctx) {
  console.log(`[${new Date().toISOString()}] ${action} by ${ctx.from.username || ctx.from.id}`);
}

// Ensure user is subscribed (or is admin)
async function ensureSubscribed(ctx) {
  const userId = ctx.from.id;

  // Banned?
  if (config.banned.includes(userId)) {
    await ctx.reply('🚫 You are banned from using this bot.');
    return false;
  }

  // Super‑admin bypass
  if (ADMINS.includes(userId)) {
    auditLog('super-admin bypass', ctx);
    return true;
  }

  // Check cache
  let status = memberCache.get(userId);
  if (!status) {
    try {
      const member = await ctx.telegram.getChatMember(`@${config.channel}`, userId);
      status = member.status;
      memberCache.set(userId, status);
    } catch (err) {
      await ctx.reply('⚠️ Please add me to your channel and grant me "Read Members" permission so I can verify subscriptions.');
      return false;
    }
  }

  if (['creator', 'administrator', 'member'].includes(status)) {
    auditLog(`subscribed as ${status}`, ctx);
    return true;
  }

  // Not subscribed—prompt to join
  const border = [
    '╭' + '─'.repeat(28) + '╮',
    '│   🔒 Premium Content 🔒   │',
    '╰' + '─'.repeat(28) + '╯',
  ].join('\n');
  const keyboard = Markup.inlineKeyboard([
    Markup.button.url('➡️ Join Channel', `https://t.me/${config.channel}`),
    Markup.button.switchToCurrentChat('📋 Copy Bot Link', BASE_URL)
  ], { columns: 2 });

  await ctx.replyWithHTML(
    `<pre>${border}</pre>\n\n` +
    `⚠️ <b>You must join @${config.channel} to use this bot!</b>`,
    keyboard
  );
  return false;
}

// Super‑admin commands
bot.command('setchannel', async ctx => {
  if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ Forbidden');
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) return ctx.reply('Usage: /setchannel <channel_username>');
  config.channel = parts[1].replace(/^@/, '');
  saveConfig();
  await ctx.reply(`✅ Channel updated to @${config.channel}`);
});

bot.command('ban', async ctx => {
  if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ Forbidden');
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('Usage: /ban <userId>');
  if (!config.banned.includes(id)) config.banned.push(id);
  saveConfig();
  await ctx.reply(`🚫 Banned user ${id}`);
});

bot.command('unban', async ctx => {
  if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ Forbidden');
  const id = Number(ctx.message.text.split(' ')[1]);
  config.banned = config.banned.filter(x => x !== id);
  saveConfig();
  await ctx.reply(`✅ Unbanned user ${id}`);
});

bot.command('stats', async ctx => {
  if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ Forbidden');
  const total = config.stats.requests;
  const unique = Object.keys(config.stats.users).length;
  await ctx.reply(`📊 Requests: ${total}\n👥 Unique Users: ${unique}`);
});

bot.command('broadcast', async ctx => {
  if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ Forbidden');
  const msg = ctx.message.text.split(' ').slice(1).join(' ');
  if (!msg) return ctx.reply('Usage: /broadcast <message>');
  const recipients = Object.keys(config.stats.users).map(id => Number(id));
  recipients.forEach(id => {
    ctx.telegram.sendMessage(id, msg).catch(() => {});
  });
  await ctx.reply(`📣 Broadcast sent to ${recipients.length} users.`);
});

// Interactive admin panel
bot.command('admin', async ctx => {
  if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ Forbidden');
  const kb = Markup.inlineKeyboard([
    Markup.button.callback('Stats', 'ADMIN_STATS'),
    Markup.button.callback('Broadcast', 'ADMIN_BROADCAST'),
    Markup.button.callback('Set Channel', 'ADMIN_SETCHANNEL')
  ], { columns: 1 });
  await ctx.reply('🛠️ Admin Panel', kb);
});

bot.action('ADMIN_STATS', ctx => ctx.reply('Use /stats'));
bot.action('ADMIN_BROADCAST', ctx => ctx.reply('Use /broadcast <msg>'));
bot.action('ADMIN_SETCHANNEL', ctx => ctx.reply('Use /setchannel <channel_username>'));

bot.command('testupload', async ctx => {
  if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ Forbidden');
  await ctx.reply('✅ Test mode: bypassing subscription. Send a photo to test.');
});

// Handle /start
bot.start(ctx =>
  ctx.reply('👋 Send me any image (or album) and I’ll return a Telegra.ph link!')
);

// Handle photos (single & albums)
bot.on('photo', async ctx => {
  if (!await ensureSubscribed(ctx)) return;

  // Update analytics
  config.stats.requests++;
  config.stats.users[ctx.from.id] = (config.stats.users[ctx.from.id] || 0) + 1;
  saveConfig();

  const photos = ctx.message.photo;
  const links = [];

  for (let p of photos) {
    const file = await ctx.telegram.getFile(p.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });

    const form = new FormData();
    form.append('file', resp.data, { filename: 'image.jpg', contentType: 'image/jpeg' });

    const upload = await axios.post('https://telegra.ph/upload', form, {
      headers: form.getHeaders()
    });

    if (upload.data?.[0]?.src) {
      links.push(`https://telegra.ph${upload.data[0].src}`);
    }
  }

  // Build inline buttons
  const buttons = [];
  for (let url of links) {
    buttons.push(
      Markup.button.switchToCurrentChat('📋 Copy Link', url),
      Markup.button.url('🌐 Open', url)
    );
  }
  const keyboard = Markup.inlineKeyboard(buttons, { columns: 2 });

  await ctx.reply('✅ Here are your Telegra.ph link(s):', keyboard);
});

// Error handling
bot.catch((err, ctx) => console.error(`Error for ${ctx.updateType}:`, err));

// Launch
bot.launch()
  .then(() => console.log('🤖 Bot started'))
  .catch(console.error);

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
