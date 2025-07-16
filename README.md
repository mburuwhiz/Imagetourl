# 🖼️ Image to Telegraph Link Bot (Imagetourl)

This is a powerful Telegram bot that helps users convert images to **Telegra.ph links**, preview them, schedule uploads, and more — with full **admin controls**, **inline widget support**, and **link health checking**.

> 🔗 **Live Deploy**: [Deploy to Render](https://render.com/deploy?repo=https://github.com/mburuwhiz/Imagetourl)

---

## 🚀 Features

- 📤 Upload image and get Telegra.ph link
- 🖼️ Thumbnail preview & confirmation before publish
- 🕓 Schedule future image publishing
- 🔍 Inline-mode and text-mode **Link Health Checker**
- 🎛️ Inline menu navigation
- 📊 Admin panel with stats, ban control, referrals, and recovery tokens
- 🔐 Force channel subscription before use
- 🧠 Smart caching and auto cleanup

---

## ⚙️ Deploy via Render

> 📌 You must set environment variables for your bot to work.

### 🔧 Required Environment Variables

| Key                | Description                        | Example                         |
|--------------------|------------------------------------|---------------------------------|
| `BOT_TOKEN`         | Telegram bot token                 | `123456:ABC-xyz...`             |
| `ADMIN_ID`          | Your Telegram numeric ID           | `123456789`                     |
| `BOT_USERNAME`      | Bot username (no @)                | `imagetourl_bot`                |
| `FORCE_SUB_CHANNEL` | Your channel (with or without @)   | `@mychannel` or `mychannel`     |

---

## 📦 Manual Setup (Optional)

```bash
git clone https://github.com/mburuwhiz/Imagetourl
cd Imagetourl
cp .env.example .env        # or manually create .env
npm install
node index.js
