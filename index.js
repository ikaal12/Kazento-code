const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ==================== CONFIG ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAX_HISTORY = 20;
const ALLOWED_CHANNEL_IDS = []; // kosongkan = bot aktif di semua channel
const TEMP_DIR = './temp_files';

const BASE_URL = 'https://opencode.ai/zen';
const API_KEY = 'opencode-api-key';
const MODEL = 'minimax-m2.5-free';

// ==================== INIT ====================
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ]
});

const anthropic = new Anthropic({ apiKey: API_KEY, baseURL: BASE_URL });
const userHistory = new Map();

const SYSTEM_PROMPT = `You are an elite coding assistant bot on Discord. Rules:
- Jawab dalam bahasa yang sama dengan user (Indonesia atau Inggris)
- Expert di semua bahasa: JS, TS, Python, Go, Rust, PHP, Java, C/C++, dll
- Kalau kasih code, SELALU pakai markdown code block dengan bahasa yang benar
- Kalau fix code, jelasin singkat apa yang salah dan apa yang difix
- Kalau user ngirim file, baca dan analisa isinya dengan teliti
- Kalau diminta generate file, output code yang lengkap dan langsung bisa dipakai
- Jawaban singkat tapi lengkap, no bullshit, no filler
- Kalau user minta output berupa file, balas dengan tag [FILE:namafile.ext] lalu isi codenya

Format kalau output file:
[FILE:namafile.ext]
\`\`\`bahasa
isi code disini
\`\`\`

Jangan pernah potong code di tengah. Selalu kasih yang complete.`;

// ==================== HELPERS ====================

function getHistory(userId) {
  if (!userHistory.has(userId)) userHistory.set(userId, []);
  return userHistory.get(userId);
}

function addHistory(userId, role, content) {
  const hist = getHistory(userId);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORY * 2) hist.splice(0, hist.length - MAX_HISTORY * 2);
}

function clearHistory(userId) {
  userHistory.set(userId, []);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch { return null; }
}

function extractFileFromResponse(text) {
  const fileMatch = text.match(/\[FILE:([^\]]+)\]/);
  if (!fileMatch) return null;
  const filename = fileMatch[1].trim();
  const codeMatch = text.match(/```[\w]*\n([\s\S]*?)```/);
  if (!codeMatch) return null;
  return { filename, content: codeMatch[1] };
}

function splitMessage(text, maxLen = 1950) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

const TEXT_EXTENSIONS = [
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.php', '.java',
  '.c', '.cpp', '.h', '.cs', '.rb', '.swift', '.kt', '.lua', '.sh',
  '.json', '.yaml', '.yml', '.toml', '.env', '.txt', '.md', '.html',
  '.css', '.scss', '.sql', '.xml', '.vue', '.svelte', '.dart', '.r',
  '.hs', '.ex', '.exs', '.clj', '.fs', '.pl', '.zig'
];

function isTextFile(filename) {
  return TEXT_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

// ==================== MESSAGE HANDLER ====================

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(message.channel.id)) return;

  const userId = message.author.id;
  const userMessage = message.content.trim();

  // Reset history
  if (userMessage.toLowerCase() === '!clear' || userMessage.toLowerCase() === '!reset') {
    clearHistory(userId);
    return message.reply('History chat lo udah dihapus. Mulai fresh.');
  }

  if (!userMessage && message.attachments.size === 0) return;

  await message.channel.sendTyping();

  // Proses file attachment
  const fileContents = [];
  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      const filename = attachment.name;
      const ext = path.extname(filename).toLowerCase();
      if (isTextFile(filename)) {
        const tempPath = path.join(TEMP_DIR, `${userId}_${Date.now()}_${filename}`);
        try {
          await downloadFile(attachment.url, tempPath);
          const content = readTextFile(tempPath);
          fs.unlink(tempPath, () => {});
          if (content) {
            fileContents.push(`\n\n--- FILE: ${filename} ---\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\`\n--- END FILE ---`);
          }
        } catch {
          fileContents.push(`\n[Gagal baca file: ${filename}]`);
        }
      } else {
        fileContents.push(`\n[File: ${filename} - format ini ga bisa dibaca]`);
      }
    }
  }

  const fullUserMessage = (userMessage || 'Tolong analisa file ini.') + fileContents.join('');
  addHistory(userId, 'user', fullUserMessage);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: getHistory(userId),
    });

    const aiReply = response.content[0].text;
    addHistory(userId, 'assistant', aiReply);

    const fileData = extractFileFromResponse(aiReply);

    if (fileData) {
      const filePath = path.join(TEMP_DIR, fileData.filename);
      fs.writeFileSync(filePath, fileData.content, 'utf-8');
      const attachment = new AttachmentBuilder(filePath, { name: fileData.filename });
      const cleanReply = aiReply.replace(/\[FILE:[^\]]+\]/, '').trim();
      const chunks = splitMessage(cleanReply || `File **${fileData.filename}** siap:`);

      for (let i = 0; i < chunks.length - 1; i++) await message.reply(chunks[i]);
      await message.reply({
        content: chunks[chunks.length - 1] || `File **${fileData.filename}**:`,
        files: [attachment]
      });
      fs.unlink(filePath, () => {});
    } else {
      const chunks = splitMessage(aiReply);
      for (const chunk of chunks) await message.reply(chunk);
    }

  } catch (err) {
    console.error('Error:', err);
    if (err.status === 429) return message.reply('Rate limit. Tunggu bentar.');
    else if (err.status === 401) return message.reply('API key salah.');
    else return message.reply(`Error: ${err.message || 'Unknown'}`);
  }
});

client.once('ready', () => {
  console.log(`✅ Bot ${client.user.tag} online!`);
  client.user.setActivity('ngoding | !clear reset chat', { type: 0 });
});

client.login(DISCORD_TOKEN);
