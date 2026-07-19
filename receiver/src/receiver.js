'use strict';
/*
 * 局域网提审、审核与交付工具 —— 接收端
 * 运行在接收文件的电脑上（笔记本），端口 8700。
 * 功能：配对确认、选择保存位置、接收并校验交付文件、展示交付记录。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');

const PORT = 8700;
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RECORD_FILE = path.join(DATA_DIR, 'deliveries.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 小工具 ---------- */
function uuid() { return crypto.randomUUID(); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel.length) return null;
  const normalized = path.normalize(rel).replace(/^([/\\])+/, '');
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  const abs = path.resolve(root, normalized);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch { return null; }
}
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}
function sanitizeFolderName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名';
}

/* ---------- 配置与记录 ---------- */
function defaultSaveDir() { return path.join(os.homedir(), 'Downloads', '提审交付接收'); }
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!c.saveDir) c.saveDir = defaultSaveDir();
    if (!Array.isArray(c.creators)) c.creators = [];
    return c;
  } catch { return { saveDir: defaultSaveDir(), creators: [] }; }
}
function saveConfig(c) { atomicWrite(CONFIG_FILE, JSON.stringify(c, null, 2)); }
function loadRecords() {
  try {
    const r = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8'));
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}
function saveRecords(r) { atomicWrite(RECORD_FILE, JSON.stringify(r, null, 2)); }

let config = loadConfig();
let records = loadRecords();
/* 程序重启：进行中的交付一律标记为失败，不假装成功 */
for (const r of records) {
  if (r.status === 'receiving') { r.status = 'failed'; r.error = '接收端程序重启导致中断，请创作者重新交付'; r.finishedAt = Date.now(); }
}
saveRecords(records);
fs.mkdirSync(config.saveDir, { recursive: true });

const live = new Map(); // deliveryId -> {received, total, currentFile}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* 配对请求暂存 */
const pendingPairs = new Map(); // requestId -> {code, name, expiresAt}

function auth(req, res, next) {
  const token = req.headers['x-receiver-token'];
  if (!token || !config.creators.some(c => c.token === token)) {
    return res.status(401).json({ error: '未授权：请先完成配对' });
  }
  req.creator = config.creators.find(c => c.token === token);
  next();
}

/* ---- 配对 ---- */
app.post('/api/pair/request', (req, res) => {
  const name = String((req.body || {}).name || '一台创作者电脑').slice(0, 60);
  const requestId = uuid();
  const code = String(crypto.randomInt(1000, 9999));
  pendingPairs.set(requestId, { code, name, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ requestId });
});

app.post('/api/pair/confirm', (req, res) => {
  const { requestId, code } = req.body || {};
  const p = pendingPairs.get(requestId);
  if (!p || p.expiresAt < Date.now()) return res.status(400).json({ error: '配对请求不存在或已过期，请重新发起' });
  if (String(code || '').trim() !== p.code) return res.status(400).json({ error: '确认码不正确，请核对本机接收端页面上显示的数字' });
  pendingPairs.delete(requestId);
  const token = uuid();
  config.creators = config.creators.filter(c => c.name !== p.name);
  config.creators.push({ token, name: p.name, pairedAt: Date.now() });
  saveConfig(config);
  res.json({ token, deviceName: os.hostname() });
});

/* ---- 状态（创作者服务探测用） ---- */
app.get('/api/status', auth, (req, res) => {
  res.json({
    deviceName: os.hostname(),
    saveDir: config.saveDir,
    free: freeBytes(config.saveDir),
    deliveries: Object.fromEntries(live)
  });
});

/* ---- 本地页面 API（本机用户操作） ---- */
app.get('/api/local/state', (req, res) => {
  res.json({
    deviceName: os.hostname(),
    addresses: lanAddresses().map(a => ({ ...a, url: `http://${a.address}:${PORT}` })),
    port: PORT,
    saveDir: config.saveDir,
    free: freeBytes(config.saveDir),
    pendingPairs: [...pendingPairs.entries()]
      .filter(([, p]) => p.expiresAt > Date.now())
      .map(([id, p]) => ({ requestId: id, code: p.code, name: p.name })),
    creators: config.creators.map(c => ({ name: c.name, pairedAt: c.pairedAt })),
    records: records.slice().sort((a, b) => b.startedAt - a.startedAt),
    live: Object.fromEntries(live)
  });
});

app.get('/api/local/save-locations', (req, res) => {
  const home = os.homedir();
  const candidates = [
    { name: '下载 / 提审交付接收（推荐）', path: path.join(home, 'Downloads', '提审交付接收') },
    { name: '桌面 / 提审交付接收', path: path.join(home, 'Desktop', '提审交付接收') },
    { name: '文稿 / 提审交付接收', path: path.join(home, 'Documents', '提审交付接收') },
    { name: '下载文件夹根目录', path: path.join(home, 'Downloads') }
  ];
  res.json({ locations: candidates.filter(c => { try { fs.mkdirSync(c.path, { recursive: true }); return true; } catch { return false; } }) });
});

app.post('/api/local/config', (req, res) => {
  const dir = String((req.body || {}).saveDir || '');
  if (!dir) return res.status(400).json({ error: '保存位置不能为空' });
  const abs = path.resolve(dir);
  try {
    fs.mkdirSync(abs, { recursive: true });
    fs.accessSync(abs, fs.constants.W_OK);
  } catch (e) { return res.status(400).json({ error: '该位置不可写：' + e.message }); }
  config.saveDir = abs;
  saveConfig(config);
  res.json({ saveDir: abs, free: freeBytes(abs) });
});

app.post('/api/local/unpair', (req, res) => {
  const name = String((req.body || {}).name || '');
  config.creators = config.creators.filter(c => c.name !== name);
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/api/local/open-save-dir', (req, res) => {
  const abs = config.saveDir;
  const cmd = process.platform === 'win32' ? `explorer "${abs}"` : process.platform === 'darwin' ? `open "${abs}"` : `xdg-open "${abs}"`;
  exec(cmd, () => res.json({ ok: true }));
});

/* ---- 交付接收 ---- */
app.post('/api/deliveries', auth, (req, res) => {
  const { deliveryId, projectFolder, versionLabel, totalFiles, totalBytes } = req.body || {};
  if (!deliveryId || !projectFolder || !versionLabel) return res.status(400).json({ error: '交付信息不完整' });
  const free = freeBytes(config.saveDir);
  if (free !== null && typeof totalBytes === 'number' && free < totalBytes * 1.05) {
    return res.status(507).json({ error: `接收电脑存储空间不足：需要约 ${(totalBytes / 1073741824).toFixed(2)} GB，剩余 ${(free / 1073741824).toFixed(2)} GB` });
  }
  let rec = records.find(r => r.id === deliveryId);
  if (!rec) {
    rec = {
      id: deliveryId, projectFolder: sanitizeFolderName(projectFolder),
      versionLabel: sanitizeFolderName(versionLabel),
      creatorName: req.creator.name, status: 'receiving',
      startedAt: Date.now(), finishedAt: null, error: null,
      totalFiles: totalFiles || 0, totalBytes: totalBytes || 0,
      files: [], savedTo: null
    };
    records.push(rec);
  } else {
    rec.status = 'receiving'; rec.error = null; rec.finishedAt = null; rec.startedAt = Date.now();
    rec.creatorName = req.creator.name;
    rec.files = [];
  }
  live.set(deliveryId, { received: 0, total: rec.totalBytes, currentFile: null });
  saveRecords(records);
  res.json({ ok: true });
});

app.put('/api/deliveries/:id/file', auth, (req, res) => {
  const rec = records.find(r => r.id === req.params.id);
  if (!rec || rec.status !== 'receiving') return res.status(400).json({ error: '交付不存在或已结束，请重新发起交付' });
  const rel = String(req.query.rel || '');
  const expectSha = String(req.query.sha256 || '');
  const expectSize = Number(req.query.size || -1);
  const destRoot = path.join(config.saveDir, rec.projectFolder, rec.versionLabel);
  const dest = safeJoin(destRoot, rel);
  if (!dest) return res.status(400).json({ error: '文件路径不合法' });
  const free = freeBytes(config.saveDir);
  if (free !== null && expectSize > 0 && free < expectSize * 1.05) {
    return res.status(507).json({ error: `存储空间不足，无法接收 ${path.basename(rel)}` });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '. receiving-' + process.pid;
  const ws = fs.createWriteStream(tmp);
  let received = 0;
  const lv = live.get(rec.id);
  req.on('data', chunk => {
    received += chunk.length;
    if (lv) { lv.currentFile = rel; lv.received += chunk.length; }
  });
  req.pipe(ws);
  ws.on('finish', async () => {
    try {
      if (expectSize >= 0 && received !== expectSize) {
        fs.unlinkSync(tmp);
        throw new Error(`文件大小不符（收到 ${received} 字节，应为 ${expectSize} 字节）`);
      }
      const sha = await sha256File(tmp);
      if (expectSha && sha !== expectSha) {
        fs.unlinkSync(tmp);
        throw new Error('文件校验失败：传输内容与创作者提交的版本不一致');
      }
      fs.renameSync(tmp, dest);
      rec.files.push({ relPath: rel, size: received, sha256: sha, status: 'done' });
      saveRecords(records);
      res.json({ ok: true });
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      res.status(400).json({ error: e.message });
    }
  });
  ws.on('error', e => {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    res.status(500).json({ error: '写入磁盘失败：' + e.message });
  });
  req.on('error', () => {
    try { ws.destroy(); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  });
});

app.post('/api/deliveries/:id/finish', auth, (req, res) => {
  const rec = records.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: '交付记录不存在' });
  const failed = rec.files.filter(f => f.status !== 'done');
  if (failed.length) {
    rec.status = 'failed';
    rec.error = '有文件未成功接收';
  } else {
    rec.status = 'done';
    rec.savedTo = path.join(config.saveDir, rec.projectFolder, rec.versionLabel);
  }
  rec.finishedAt = Date.now();
  live.delete(rec.id);
  saveRecords(records);
  res.json({ ok: rec.status === 'done', savedTo: rec.savedTo, error: rec.error });
});

app.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses().map(a => `http://${a.address}:${PORT}`).join('  ');
  console.log('================================================');
  console.log('  提审交付 · 接收端已启动');
  console.log('  本机页面:  http://localhost:' + PORT);
  if (addrs) console.log('  告诉创作者此地址:  ' + addrs);
  console.log('  文件保存到:  ' + config.saveDir);
  console.log('================================================');
  const url = 'http://localhost:' + PORT;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
});
