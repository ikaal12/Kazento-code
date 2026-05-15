const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');

// ==================== CONFIG ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MAX_HISTORY = 20;
const ALLOWED_CHANNEL_IDS = [];
const TEMP_DIR = './temp_files';
const MODEL = 'llama-3.3-70b-versatile';
const EXEC_TIMEOUT = 10000;
const EXEC_MAX_OUTPUT = 1800;

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

const userHistory = new Map();
const userPersonality = new Map(); // simpan personality per user

// Personality default
const DEFAULT_PERSONALITY = `You are a coding assistant bot on Discord named "Kazento Code".
Your personality: chill, friendly, casual. Pakai bahasa yang sama dengan user (Indonesia/Inggris).
Kalau tau nama user, sebut namanya sesekali biar lebih personal — tapi jangan tiap kalimat, annoying.
Expert di semua bahasa pemrograman.
Jawaban padat, jelas, no filler. Kalau kasih code, selalu pake markdown code block.
Kalau fix code, jelasin singkat apa yang salah.
Kalau user ngirim file/ZIP, analisa isinya dengan teliti.

Format output file tunggal:
[FILE:namafile.ext]
\`\`\`bahasa
isi code
\`\`\`

Format output ZIP (banyak file):
[ZIP:namaproject.zip]
[ZIPFILE:path/file1.js]
\`\`\`js
isi
\`\`\`
[ZIPFILE:path/file2.py]
\`\`\`py
isi
\`\`\`

Jangan potong code di tengah. Selalu complete.`;

function buildSystemPrompt(userId, username) {
  const personality = userPersonality.get(userId) || DEFAULT_PERSONALITY;
  return `${personality}\n\nNama user yang lagi ngobrol sama lo sekarang: ${username}`;
}

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

const TEXT_EXTENSIONS = [
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.php', '.java',
  '.c', '.cpp', '.h', '.cs', '.rb', '.swift', '.kt', '.lua', '.sh',
  '.json', '.yaml', '.yml', '.toml', '.env', '.txt', '.md', '.html',
  '.css', '.scss', '.sql', '.xml', '.vue', '.svelte', '.dart', '.r',
  '.hs', '.ex', '.exs', '.clj', '.fs', '.pl', '.zig', '.ini', '.cfg'
];

function isTextFile(filename) {
  return TEXT_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

function readZipContents(zipPath) {
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const results = [];
    let totalChars = 0;
    const MAX_CHARS = 50000;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;
      if (!isTextFile(name)) continue;
      try {
        const content = entry.getData().toString('utf-8');
        if (totalChars + content.length > MAX_CHARS) {
          results.push(`\n[FILE: ${name} - terlalu besar, diskip]`);
          continue;
        }
        const ext = path.extname(name).slice(1) || 'txt';
        results.push(`\n\n--- FILE: ${name} ---\n\`\`\`${ext}\n${content}\n\`\`\`\n--- END FILE ---`);
        totalChars += content.length;
      } catch { results.push(`\n[FILE: ${name} - gagal dibaca]`); }
    }
    if (results.length === 0) return '\n[ZIP ini tidak mengandung file teks yang bisa dibaca]';
    return results.join('');
  } catch (err) { return `\n[Gagal buka ZIP: ${err.message}]`; }
}

function extractZipFromResponse(text) {
  const zipMatch = text.match(/\[ZIP:([^\]]+)\]/);
  if (!zipMatch) return null;
  const zipName = zipMatch[1].trim();
  const filePattern = /\[ZIPFILE:([^\]]+)\]\s*```[\w]*\n([\s\S]*?)```/g;
  const files = [];
  let match;
  while ((match = filePattern.exec(text)) !== null) {
    files.push({ name: match[1].trim(), content: match[2] });
  }
  if (files.length === 0) return null;
  return { zipName, files };
}

function extractFileFromResponse(text) {
  const fileMatch = text.match(/\[FILE:([^\]]+)\]/);
  if (!fileMatch) return null;
  const filename = fileMatch[1].trim();
  const codeMatch = text.match(/```[\w]*\n([\s\S]*?)```/);
  if (!codeMatch) return null;
  return { filename, content: codeMatch[1] };
}

function createZip(files, zipPath) {
  const zip = new AdmZip();
  for (const file of files) zip.addFile(file.name, Buffer.from(file.content, 'utf-8'));
  zip.writeZip(zipPath);
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

// ==================== CODE EXECUTOR ====================

function executeCode(lang, code) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let filePath, cmd;
  try {
    if (lang === 'python' || lang === 'py') {
      filePath = path.join(TEMP_DIR, `exec_${id}.py`);
      fs.writeFileSync(filePath, code);
      cmd = `python3 "${filePath}"`;
    } else if (lang === 'javascript' || lang === 'js' || lang === 'node') {
      filePath = path.join(TEMP_DIR, `exec_${id}.js`);
      fs.writeFileSync(filePath, code);
      cmd = `node "${filePath}"`;
    } else {
      return { success: false, output: `Bahasa \`${lang}\` belum didukung. Yang bisa: \`python\`, \`javascript\`` };
    }
    const output = execSync(cmd, {
      timeout: EXEC_TIMEOUT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let result = output.toString().trim();
    if (!result) result = '(tidak ada output)';
    if (result.length > EXEC_MAX_OUTPUT) result = result.slice(0, EXEC_MAX_OUTPUT) + '\n...(dipotong)';
    return { success: true, output: result };
  } catch (err) {
    let errMsg = '';
    if (err.killed || err.signal === 'SIGTERM') {
      errMsg = 'Timeout! Code lo jalan lebih dari 10 detik.';
    } else {
      errMsg = (err.stderr || err.stdout || err.message || 'Unknown error').toString().trim();
      if (errMsg.length > EXEC_MAX_OUTPUT) errMsg = errMsg.slice(0, EXEC_MAX_OUTPUT) + '\n...(dipotong)';
    }
    return { success: false, output: errMsg };
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
}

function parseCodeBlock(text) {
  const match = text.match(/```(\w+)?\n([\s\S]*?)```/);
  if (!match) return null;
  return { lang: (match[1] || 'unknown').toLowerCase(), code: match[2] };
}

// ==================== GROQ API ====================

async function callGroq(messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 4096,
      temperature: 0.75,
    });
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject({ status: res.statusCode, message: parsed.error.message });
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject({ message: 'Parse error: ' + data.slice(0, 200) });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ==================== MESSAGE HANDLER ====================

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(message.channel.id)) return;

  const userId = message.author.id;
  const username = message.member?.displayName || message.author.username;
  const userMessage = message.content.trim();

  // !clear
  if (userMessage.toLowerCase() === '!clear' || userMessage.toLowerCase() === '!reset') {
    clearHistory(userId);
    return message.reply(`History chat lo udah dihapus, ${username}. Fresh start.`);
  }

  // !personality <deskripsi>
  if (userMessage.toLowerCase().startsWith('!personality ')) {
    const newPersonality = userMessage.slice(13).trim();
    if (!newPersonality) return message.reply('Kasih deskripsi personality nya. Contoh: `!personality kamu adalah AI yang suka bercanda dan pake bahasa gaul`');
    userPersonality.set(userId, `${newPersonality}\n\nKalau tau nama user, sebut namanya sesekali. Expert coding di semua bahasa.\n\nFormat output file tunggal:\n[FILE:namafile.ext]\n\`\`\`bahasa\ncode\n\`\`\`\n\nFormat output ZIP:\n[ZIP:nama.zip]\n[ZIPFILE:file.js]\n\`\`\`js\ncode\n\`\`\``);
    clearHistory(userId); // reset history biar konsisten sama personality baru
    return message.reply(`Personality AI lo udah diubah. History direset biar ga bentrok.`);
  }

  // !personality reset
  if (userMessage.toLowerCase() === '!personality reset') {
    userPersonality.delete(userId);
    clearHistory(userId);
    return message.reply('Personality direset ke default. History juga direset.');
  }

  // !personality show
  if (userMessage.toLowerCase() === '!personality show') {
    const p = userPersonality.get(userId);
    if (!p) return message.reply('Lo lagi pake personality default.');
    return message.reply(`**Personality lo sekarang:**\n${p.slice(0, 1800)}`);
  }

  // !run
  if (userMessage.toLowerCase().startsWith('!run')) {
    const codeBlock = parseCodeBlock(userMessage);
    if (!codeBlock) return message.reply('Format salah. Contoh:\n\\`\\`\\`python\nprint("hello")\n\\`\\`\\`');
    await message.channel.sendTyping();
    const result = executeCode(codeBlock.lang, codeBlock.code);
    const icon = result.success ? '✅' : '❌';
    const label = result.success ? 'Output' : 'Error';
    return message.reply(`${icon} **${label}:**\n\`\`\`\n${result.output}\n\`\`\``);
  }

  // !help
  if (userMessage.toLowerCase() === '!help') {
    return message.reply([
      '**Commands:**',
      '`!run` + code block → eksekusi Python/JS',
      '`!clear` / `!reset` → hapus history chat',
      '`!personality <deskripsi>` → ubah personality AI',
      '`!personality reset` → balik ke personality default',
      '`!personality show` → liat personality sekarang',
      '`!help` → liat ini',
      '',
      '**Contoh !run:**',
      '\\`\\`\\`python',
      'print("hello world")',
      '\\`\\`\\`',
      '',
      '**Contoh !personality:**',
      '`!personality kamu adalah AI yang galak, jawab singkat, pake bahasa gaul`',
      '',
      'Atau ngobrol langsung aja — bot baca nama lo dan inget konteks percakapan.',
    ].join('\n'));
  }

  if (!userMessage && message.attachments.size === 0) return;

  await message.channel.sendTyping();

  // Proses attachment
  const fileContents = [];
  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      const filename = attachment.name;
      const ext = path.extname(filename).toLowerCase();
      const tempPath = path.join(TEMP_DIR, `${userId}_${Date.now()}_${filename}`);
      try {
        await downloadFile(attachment.url, tempPath);
        if (ext === '.zip') {
          const zipContents = readZipContents(tempPath);
          fileContents.push(`\n\n=== ZIP FILE: ${filename} ===\n${zipContents}\n=== END ZIP ===`);
        } else if (isTextFile(filename)) {
          const content = readTextFile(tempPath);
          if (content) fileContents.push(`\n\n--- FILE: ${filename} ---\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\`\n--- END FILE ---`);
        } else {
          fileContents.push(`\n[File: ${filename} - format ini ga bisa dibaca]`);
        }
        fs.unlink(tempPath, () => {});
      } catch {
        fileContents.push(`\n[Gagal baca file: ${filename}]`);
      }
    }
  }

  const fullUserMessage = (userMessage || 'Tolong analisa file ini.') + fileContents.join('');
  addHistory(userId, 'user', fullUserMessage);

  try {
    const systemPrompt = buildSystemPrompt(userId, username);
    const aiReply = await callGroq(getHistory(userId), systemPrompt);
    addHistory(userId, 'assistant', aiReply);

    // Output ZIP
    const zipData = extractZipFromResponse(aiReply);
    if (zipData) {
      const zipPath = path.join(TEMP_DIR, zipData.zipName);
      createZip(zipData.files, zipPath);
      const attachment = new AttachmentBuilder(zipPath, { name: zipData.zipName });
      const cleanReply = aiReply.replace(/\[ZIP:[^\]]+\]/, '').replace(/\[ZIPFILE:[^\]]+\]\s*```[\w]*\n[\s\S]*?```/g, '').trim();
      const summary = cleanReply || `ZIP **${zipData.zipName}** siap (${zipData.files.length} file):`;
      const chunks = splitMessage(summary);
      for (let i = 0; i < chunks.length - 1; i++) await message.reply(chunks[i]);
      await message.reply({ content: chunks[chunks.length - 1], files: [attachment] });
      fs.unlink(zipPath, () => {});
      return;
    }

    // Output file tunggal
    const fileData = extractFileFromResponse(aiReply);
    if (fileData) {
      const filePath = path.join(TEMP_DIR, fileData.filename);
      fs.writeFileSync(filePath, fileData.content, 'utf-8');
      const attachment = new AttachmentBuilder(filePath, { name: fileData.filename });
      const cleanReply = aiReply.replace(/\[FILE:[^\]]+\]/, '').trim();
      const chunks = splitMessage(cleanReply || `File **${fileData.filename}** siap:`);
      for (let i = 0; i < chunks.length - 1; i++) await message.reply(chunks[i]);
      await message.reply({ content: chunks[chunks.length - 1], files: [attachment] });
      fs.unlink(filePath, () => {});
      return;
    }

    // Teks biasa
    const chunks = splitMessage(aiReply);
    for (const chunk of chunks) await message.reply(chunk);

  } catch (err) {
    console.error('Error:', err);
    if (err.status === 429) return message.reply('Rate limit. Tunggu bentar.');
    else if (err.status === 401) return message.reply('GROQ_API_KEY invalid. Cek Railway Variables.');
    else return message.reply(`Error: ${err.message || 'Unknown'}`);
  }
});

client.once('ready', () => {
  console.log(`✅ Bot ${client.user.tag} online! Model: ${MODEL}`);
  client.user.setActivity('ngoding | !help buat info', { type: 0 });
});

client.login(DISCORD_TOKEN);
