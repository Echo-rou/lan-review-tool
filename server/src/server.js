'use strict';
/*
 * 局域网提审、审核与交付工具 —— 创作者主服务
 * 端口 8600。提供：创作者页面、审核页面、配对、版本快照、评论、交付推送。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const store = require('./store');
const U = require('./util');

const PORT = 8600;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'join.html')));
app.get('/review', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'review.html')));

/* ================= 基础助手 ================= */

function workspace() {
  const cfg = store.loadConfig();
  return cfg.workspace || null;
}
function requireWorkspace(res) {
  const ws = workspace();
  if (!ws) { res.status(400).json({ error: '尚未选择工作区' }); return null; }
  return ws;
}
function data() { return store.loadData(workspace()); }
function save() { store.saveData(workspace()); }

function projectAbs(p) { return path.join(workspace(), p.folder); }

function findProject(id) { return data().projects.find(p => p.id === id); }
function findVersion(id) { return data().versions.find(v => v.id === id); }
function findDevice(id) { return data().devices.find(d => d.id === id); }

/* 设备鉴权：审核接口用。token 可放在 header 或 query（视频/图片标签只能带 query） */
function deviceAuth(req, res, next) {
  const ws = workspace();
  if (!ws) return res.status(400).json({ error: '服务未就绪' });
  const token = req.headers['x-device-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: '未授权：缺少设备凭证' });
  const dev = data().devices.find(d => d.token === token);
  if (!dev) return res.status(401).json({ error: '未授权：设备不存在或已被移除' });
  if (!dev.approved) return res.status(403).json({ error: '设备尚未获得创作者授权' });
  dev.lastSeen = Date.now();
  dev.lastUserAgent = String(req.headers['user-agent'] || '').slice(0, 200);
  save();
  req.device = dev;
  next();
}

/* 在线判定 */
function reviewerOnline(dev) { return dev.lastSeen && (Date.now() - dev.lastSeen) < 30 * 1000; }

/* 接收端在线状态（内存中实时探测） */
const receiverLive = new Map(); // deviceId -> {online, saveDir, free, name, error, deliveries:{}}

function receiverUrl(dev, p) {
  let addr = dev.addr || '';
  if (!/^https?:\/\//.test(addr)) addr = 'http://' + addr;
  return addr.replace(/\/+$/, '') + p;
}

function probeReceiver(dev) {
  return new Promise(resolve => {
    const req = http.request(receiverUrl(dev, '/api/status'), {
      method: 'GET',
      headers: { 'x-receiver-token': dev.receiverToken || '' },
      timeout: 3000
    }, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(body);
          receiverLive.set(dev.id, { online: true, ...j, at: Date.now() });
        } catch {
          receiverLive.set(dev.id, { online: false, error: '返回内容无法识别', at: Date.now() });
        }
        resolve();
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => {
      receiverLive.set(dev.id, { online: false, error: '无法连接（' + (e.code || e.message) + '）', at: Date.now() });
      resolve();
    });
    req.end();
  });
}

/* 每 5 秒探测一次所有接收端 */
setInterval(() => {
  const ws = workspace(); if (!ws) return;
  for (const dev of data().devices.filter(d => d.role === 'receiver' && d.approved)) {
    probeReceiver(dev).then(ok => {
      if (receiverLive.get(dev.id)?.online) { dev.lastSeen = Date.now(); store.saveData(ws); }
    });
  }
}, 5000).unref();

/* ================= 服务器信息 / 配对码 ================= */

let pairing = null; // {code, expiresAt}

function getPairingCode() {
  if (!pairing || pairing.expiresAt < Date.now()) {
    pairing = { code: String(crypto.randomInt(100000, 999999)), expiresAt: Date.now() + 5 * 60 * 1000 };
  }
  return pairing;
}

app.get('/api/server-info', async (req, res) => {
  const addrs = U.lanAddresses();
  const best = addrs[0]?.address || '127.0.0.1';
  const joinUrl = `http://${best}:${PORT}/join`;
  let qr = null;
  try { qr = await QRCode.toDataURL(joinUrl, { width: 220, margin: 1 }); } catch { /* 忽略 */ }
  res.json({
    port: PORT,
    addresses: addrs.map(a => ({ ...a, url: `http://${a.address}:${PORT}` })),
    joinUrl, qr,
    hostName: os.hostname()
  });
});

app.get('/api/pairing/code', (req, res) => {
  const p = getPairingCode();
  res.json({ code: p.code, expiresIn: Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)) });
});
app.post('/api/pairing/refresh', (req, res) => {
  pairing = null;
  const p = getPairingCode();
  res.json({ code: p.code, expiresIn: 300 });
});

/* 手机/笔记本浏览器加入 */
app.post('/api/join', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const { name, code } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写设备名称' });
  const p = getPairingCode();
  if (!code || String(code).trim() !== p.code) return res.status(400).json({ error: '配对码不正确或已过期，请核对创作者页面上的最新配对码' });
  const dev = {
    id: U.uuid(), name: String(name).trim().slice(0, 40), role: 'reviewer',
    token: U.uuid(), approved: false, createdAt: Date.now(), lastSeen: Date.now(),
    lastUserAgent: String(req.headers['user-agent'] || '').slice(0, 200)
  };
  data().devices.push(dev); save();
  res.json({ deviceId: dev.id, status: 'pending' });
});

app.get('/api/join/status', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const dev = findDevice(req.query.deviceId);
  if (!dev) return res.status(404).json({ error: '设备不存在，可能已被创作者移除' });
  if (!dev.approved) return res.json({ status: 'pending' });
  res.json({ status: 'approved', token: dev.token, name: dev.name, role: dev.role });
});

/* ================= 工作区 ================= */

app.get('/api/workspace', (req, res) => {
  const cfg = store.loadConfig();
  res.json({ workspace: cfg.workspace });
});

app.post('/api/workspace', (req, res) => {
  const p = String((req.body || {}).path || '');
  if (!p) return res.status(400).json({ error: '路径不能为空' });
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    try { fs.mkdirSync(abs, { recursive: true }); } catch (e) {
      return res.status(400).json({ error: '目录不存在且创建失败：' + e.message });
    }
  }
  let st;
  try { st = fs.statSync(abs); } catch (e) { return res.status(400).json({ error: '无法读取该目录：' + e.message }); }
  if (!st.isDirectory()) return res.status(400).json({ error: '所选位置不是文件夹' });
  try { fs.accessSync(abs, fs.constants.W_OK); } catch { return res.status(400).json({ error: '该文件夹没有写入权限，请换一个位置' }); }
  store.resetCache();
  const cfg = store.loadConfig();
  cfg.workspace = abs;
  store.saveConfig(cfg);
  store.loadData(abs); // 立即初始化
  store.saveData(abs);
  res.json({ workspace: abs });
});

/* 文件系统浏览（工作区选择、项目文件选择共用） */
app.get('/api/fs/roots', (req, res) => {
  const roots = [];
  if (process.platform === 'win32') {
    for (let i = 67; i <= 90; i++) { // C..Z
      const d = String.fromCharCode(i) + ':\\';
      try { fs.accessSync(d); roots.push({ name: d, path: d }); } catch { /* 不存在 */ }
    }
  } else {
    roots.push({ name: '个人文件夹', path: os.homedir() });
    roots.push({ name: '桌面', path: path.join(os.homedir(), 'Desktop') });
    roots.push({ name: '文稿', path: path.join(os.homedir(), 'Documents') });
    roots.push({ name: '/', path: '/' });
    try { fs.accessSync('/Volumes'); roots.push({ name: 'Volumes（U盘/外置盘）', path: '/Volumes' }); } catch { /* 无 */ }
  }
  res.json({ roots: roots.filter(r => { try { fs.accessSync(r.path); return true; } catch { return false; } }) });
});

app.get('/api/fs/browse', (req, res) => {
  const p = String(req.query.path || '');
  if (!p) return res.status(400).json({ error: '缺少路径' });
  const abs = path.resolve(p);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) {
    return res.status(400).json({ error: '无法打开该文件夹：' + e.message });
  }
  const dirs = [], files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === store.SYS_DIR_NAME) continue;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name, path: full });
    else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        files.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs, kind: U.fileKind(e.name) });
      } catch { /* 跳过 */ }
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  res.json({ path: abs, parent: path.dirname(abs), dirs, files });
});

/* 在系统文件管理器中打开文件夹 */
app.post('/api/open-folder', (req, res) => {
  const p = String((req.body || {}).path || '');
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件夹不存在' });
  const cmd = process.platform === 'win32' ? `explorer "${abs}"`
    : process.platform === 'darwin' ? `open "${abs}"`
    : `xdg-open "${abs}"`;
  exec(cmd, () => res.json({ ok: true }));
});

/* ================= 项目 ================= */

function projectDto(p) {
  const d = data();
  const versions = d.versions.filter(v => v.projectId === p.id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(v => versionDto(v));
  return { ...p, versions };
}

function versionDto(v) {
  const d = data();
  const status = store.versionStatus(d, v);
  const reviews = d.reviews.filter(r => r.versionId === v.id);
  const comments = d.comments.filter(c => c.versionId === v.id);
  const files = v.files.map(f => ({
    ...f,
    review: (() => {
      const r = reviews.filter(x => x.fileId === f.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return r ? { status: r.status, by: deviceName(r.deviceId), at: r.updatedAt } : null;
    })(),
    commentCount: comments.filter(c => c.fileId === f.id).length
  }));
  return {
    ...v, status, files,
    commentCount: comments.length,
    assigneeNames: (v.assignees || []).map(deviceName)
  };
}

function deviceName(id) {
  const dev = data().devices.find(x => x.id === id);
  return dev ? dev.name : '已移除设备';
}

app.get('/api/projects', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  res.json({ projects: data().projects.map(projectDto) });
});

app.post('/api/projects', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const { date, brand, name } = req.body || {};
  const clean = s => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  const d = clean(date), b = clean(brand), n = clean(name);
  if (!d || !b || !n) return res.status(400).json({ error: '日期、品牌、项目名称都不能为空' });
  const folder = `${d}_${b}_${n}`;
  const abs = path.join(ws, folder);
  if (fs.existsSync(abs)) {
    const existed = data().projects.find(p => p.folder === folder);
    return res.status(409).json({
      error: '已存在同名项目文件夹', folder,
      existingProjectId: existed ? existed.id : null
    });
  }
  fs.mkdirSync(abs, { recursive: true });
  const p = { id: U.uuid(), date: d, brand: b, name: n, folder, createdAt: Date.now() };
  data().projects.push(p); save();
  res.json({ project: projectDto(p) });
});

/* 选择已存在于磁盘上的项目文件夹继续工作 */
app.post('/api/projects/adopt', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const folder = path.basename(String((req.body || {}).folder || ''));
  if (!folder) return res.status(400).json({ error: '文件夹名不正确' });
  const abs = path.join(ws, folder);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return res.status(404).json({ error: '工作区里找不到这个文件夹' });
  let p = data().projects.find(x => x.folder === folder);
  if (!p) {
    const m = folder.match(/^(\d{4}[-.]?\d{2}[-.]?\d{2}|\d{8})[_-]([^_]+)_(.+)$/);
    p = {
      id: U.uuid(),
      date: m ? m[1] : new Date().toISOString().slice(0, 10),
      brand: m ? m[2] : '未命名品牌',
      name: m ? m[3] : folder,
      folder, createdAt: Date.now()
    };
    data().projects.push(p); save();
  }
  res.json({ project: projectDto(p) });
});

/* 上传文件到项目文件夹（拖拽/选择上传） */
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const p = findProject(req.params.id);
      if (!p) return cb(new Error('项目不存在'));
      cb(null, projectAbs(p));
    },
    filename(req, file, cb) {
      let name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      name = path.basename(name).replace(/[\\/:*?"<>|]/g, '') || ('文件-' + Date.now());
      const dir = projectAbs(findProject(req.params.id));
      let final = name, i = 1;
      while (fs.existsSync(path.join(dir, final))) {
        const ext = path.extname(name);
        final = path.basename(name, ext) + ' (' + (i++) + ')' + ext;
      }
      cb(null, final);
    }
  })
});

app.post('/api/projects/:id/upload', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  if (!findProject(req.params.id)) return res.status(404).json({ error: '项目不存在' });
  upload.array('files', 50)(req, res, err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    res.json({ ok: true, count: (req.files || []).length });
  });
});

/* 项目文件夹内容（供选择待审文件） */
app.get('/api/projects/:id/files', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const files = U.walkFiles(projectAbs(p)).map(f => ({ ...f, kind: U.fileKind(f.name) }));
  res.json({ files, folder: p.folder });
});

/* ================= 设备管理 ================= */

function deviceDto(dev) {
  const base = {
    id: dev.id, name: dev.name, role: dev.role, approved: dev.approved,
    createdAt: dev.createdAt, lastSeen: dev.lastSeen, lastUserAgent: dev.lastUserAgent
  };
  if (dev.role === 'receiver') {
    const live = receiverLive.get(dev.id);
    return {
      ...base, addr: dev.addr,
      online: !!(live && live.online),
      receiverInfo: live && live.online ? { saveDir: live.saveDir, free: live.free, deviceName: live.deviceName } : null,
      connectError: live && !live.online ? live.error : null
    };
  }
  return { ...base, online: reviewerOnline(dev) };
}

app.get('/api/devices', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  res.json({ devices: data().devices.map(deviceDto) });
});

app.post('/api/devices/:id/approve', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const dev = findDevice(req.params.id);
  if (!dev) return res.status(404).json({ error: '设备不存在' });
  dev.approved = true; save();
  res.json({ device: deviceDto(dev) });
});

app.delete('/api/devices/:id', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const d = data();
  const i = d.devices.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '设备不存在' });
  d.devices.splice(i, 1); save();
  res.json({ ok: true });
});

/* ---- 接收端配对：第一步，请求对方生成确认码 ---- */
app.post('/api/receivers/pair', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const addr = String((req.body || {}).addr || '').trim();
  if (!addr) return res.status(400).json({ error: '请填写接收端页面上显示的地址' });
  let base = addr;
  if (!/^https?:\/\//.test(base)) base = 'http://' + base;
  base = base.replace(/\/+$/, '');
  postJson(base + '/api/pair/request', { name: os.hostname() + '（创作者电脑）' }, null, 5000)
    .then(j => res.json({ requestId: j.requestId, addr: base }))
    .catch(e => res.status(400).json({ error: '连不上接收端：' + e.message + '。请确认接收电脑已启动接收端、两台电脑在同一局域网、地址输入无误。' }));
});

/* ---- 接收端配对：第二步，把对方屏幕上显示的确认码填进来 ---- */
app.post('/api/receivers/confirm', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const { addr, requestId, code } = req.body || {};
  if (!addr || !requestId || !code) return res.status(400).json({ error: '信息不完整' });
  postJson(addr + '/api/pair/confirm', { requestId, code: String(code).trim() }, null, 5000)
    .then(j => {
      const d = data();
      let dev = d.devices.find(x => x.role === 'receiver' && x.addr === addr);
      if (!dev) {
        dev = {
          id: U.uuid(), name: j.deviceName || addr, role: 'receiver',
          token: U.uuid(), approved: true, addr,
          receiverToken: j.token, createdAt: Date.now(), lastSeen: Date.now()
        };
        d.devices.push(dev);
      } else {
        dev.receiverToken = j.token; dev.approved = true; dev.name = j.deviceName || dev.name;
      }
      save();
      probeReceiver(dev).then(() => res.json({ device: deviceDto(dev) }));
    })
    .catch(e => res.status(400).json({ error: '确认失败：' + e.message }));
});

function postJson(url, obj, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST', timeout: timeoutMs,
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        ...(token ? { 'x-receiver-token': token } : {})
      }
    }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        let j; try { j = JSON.parse(b); } catch { return reject(new Error('对方返回内容无法识别')); }
        if (r.statusCode >= 400) return reject(new Error(j.error || ('对方拒绝（' + r.statusCode + '）')));
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', e => reject(new Error(e.code === 'ECONNREFUSED' ? '对方没有启动接收端或端口不对' : e.message)));
    req.write(body); req.end();
  });
}

/* ================= 版本（提审） ================= */

app.post('/api/versions', async (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const { projectId, files, note, assignees } = req.body || {};
  const p = findProject(projectId);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: '请至少选择一个文件' });
  const d = data();
  const validAssignees = (Array.isArray(assignees) ? assignees : [])
    .filter(id => { const dev = findDevice(id); return dev && dev.approved && dev.role === 'reviewer'; });
  if (!validAssignees.length) return res.status(400).json({ error: '请至少选择一台已授权的审核设备' });

  /* 展开文件夹、校验文件 */
  const root = projectAbs(p);
  const picked = [];
  for (const rel of files) {
    const abs = U.safeJoin(root, rel);
    if (!abs || !fs.existsSync(abs)) return res.status(400).json({ error: `文件不存在：${rel}` });
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const f of U.walkFiles(abs, '')) picked.push({ rel: (rel + '/' + f.relPath).replace(/^\/+/, ''), abs: path.join(abs, f.relPath), size: f.size });
    } else {
      picked.push({ rel, abs, size: st.size });
    }
  }
  if (!picked.length) return res.status(400).json({ error: '所选内容里没有可用文件' });

  const label = store.nextVersionLabel(d, projectId);
  const snapDir = path.join(store.snapshotRoot(ws), projectId, label);
  U.ensureDir(snapDir);

  /* 复制快照并计算哈希（快照一旦生成不再改动） */
  const outFiles = [];
  try {
    for (const f of picked) {
      const dst = path.join(snapDir, f.rel);
      U.ensureDir(path.dirname(dst));
      fs.copyFileSync(f.abs, dst);
      const sha = await U.sha256File(dst);
      outFiles.push({
        id: U.uuid(), relPath: f.rel, name: path.basename(f.rel),
        size: f.size, kind: U.fileKind(f.rel), sha256: sha
      });
    }
  } catch (e) {
    return res.status(500).json({ error: '复制版本快照失败：' + e.message });
  }

  const v = {
    id: U.uuid(), projectId, label, note: String(note || '').slice(0, 500),
    createdAt: Date.now(), files: outFiles, assignees: validAssignees
  };
  d.versions.push(v); save();
  res.json({ version: versionDto(v) });
});

app.get('/api/versions/:id', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const v = findVersion(req.params.id);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  const comments = data().comments.filter(c => c.versionId === v.id)
    .map(c => ({ ...c, author: deviceName(c.deviceId) }))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ version: versionDto(v), comments, project: findProject(v.projectId) });
});

/* ================= 审核端 API ================= */

app.get('/api/review/me', deviceAuth, (req, res) => {
  res.json({ name: req.device.name, role: req.device.role });
});

app.get('/api/review/tasks', deviceAuth, (req, res) => {
  const d = data();
  const mine = d.versions.filter(v => (v.assignees || []).includes(req.device.id));
  const tasks = mine.sort((a, b) => b.createdAt - a.createdAt).map(v => {
    const p = findProject(v.projectId);
    const latestForProject = d.versions.filter(x => x.projectId === v.projectId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      ...versionDto(v),
      projectName: p ? `${p.date}_${p.brand}_${p.name}` : '未知项目',
      projectFolder: p ? p.folder : '',
      isCurrent: latestForProject && latestForProject.id === v.id
    };
  });
  res.json({ tasks });
});

app.get('/api/review/versions/:id', deviceAuth, (req, res) => {
  const v = findVersion(req.params.id);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (!(v.assignees || []).includes(req.device.id)) return res.status(403).json({ error: '该版本没有分配给这台设备' });
  const comments = data().comments.filter(c => c.versionId === v.id)
    .map(c => ({ ...c, author: deviceName(c.deviceId) }))
    .sort((a, b) => a.createdAt - b.createdAt);
  const p = findProject(v.projectId);
  res.json({ version: versionDto(v), comments, projectName: p ? p.folder : '' });
});

function snapshotFilePath(v, f) {
  return path.join(store.snapshotRoot(workspace()), v.projectId, v.label, f.relPath);
}

app.get('/api/review/file/:versionId/:fileId', deviceAuth, (req, res) => {
  const v = findVersion(req.params.versionId);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (!(v.assignees || []).includes(req.device.id)) return res.status(403).json({ error: '无权查看该版本' });
  const f = v.files.find(x => x.id === req.params.fileId);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const abs = snapshotFilePath(v, f);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '版本快照文件缺失，请联系创作者' });
  res.setHeader('content-type', U.mimeOf(f.name));
  res.sendFile(abs);
});

app.get('/api/review/download/:versionId/:fileId', deviceAuth, (req, res) => {
  const v = findVersion(req.params.versionId);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (!(v.assignees || []).includes(req.device.id)) return res.status(403).json({ error: '无权下载该版本' });
  const f = v.files.find(x => x.id === req.params.fileId);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const abs = snapshotFilePath(v, f);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '版本快照文件缺失' });
  res.download(abs, f.name);
});

app.post('/api/review/comments', deviceAuth, (req, res) => {
  const v = findVersion((req.body || {}).versionId);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (!(v.assignees || []).includes(req.device.id)) return res.status(403).json({ error: '该版本没有分配给这台设备' });
  const { fileId, text, timecode } = req.body || {};
  const f = v.files.find(x => x.id === fileId);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: '评论内容不能为空' });
  const c = {
    id: U.uuid(), versionId: v.id, fileId, deviceId: req.device.id,
    text: String(text).trim().slice(0, 1000),
    timecode: (typeof timecode === 'number' && isFinite(timecode) && timecode >= 0) ? Math.round(timecode * 10) / 10 : null,
    createdAt: Date.now()
  };
  data().comments.push(c); save();
  res.json({ comment: { ...c, author: req.device.name } });
});

app.post('/api/review/mark', deviceAuth, (req, res) => {
  const v = findVersion((req.body || {}).versionId);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (!(v.assignees || []).includes(req.device.id)) return res.status(403).json({ error: '该版本没有分配给这台设备' });
  const { fileId, status } = req.body || {};
  if (!['changes', 'approved'].includes(status)) return res.status(400).json({ error: '状态不正确' });
  const f = v.files.find(x => x.id === fileId);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const d = data();
  d.reviews = d.reviews.filter(r => !(r.versionId === v.id && r.fileId === fileId && r.deviceId === req.device.id));
  d.reviews.push({ versionId: v.id, fileId, status, deviceId: req.device.id, updatedAt: Date.now() });
  save();
  res.json({ version: versionDto(v) });
});

/* ================= 交付 ================= */

const deliveryProgress = new Map(); // deliveryId -> {currentFile, currentBytes, currentTotal}

app.post('/api/deliveries', async (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const { versionId, receiverId } = req.body || {};
  const v = findVersion(versionId);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  const status = store.versionStatus(data(), v);
  if (status !== 'approved') return res.status(400).json({ error: '只有全部文件都审核通过的版本才能正式交付（当前状态：' + statusText(status) + '）' });
  const dev = findDevice(receiverId);
  if (!dev || dev.role !== 'receiver' || !dev.approved) return res.status(404).json({ error: '接收电脑不存在或未授权' });
  await probeReceiver(dev);
  const live = receiverLive.get(dev.id);
  if (!live || !live.online) return res.status(400).json({ error: '接收电脑不在线：' + (live?.error || '无法连接') + '。请确认对方已启动接收端后再试。' });

  /* 交付前校验快照完整性：文件必须仍在且哈希与提交时一致 */
  for (const f of v.files) {
    const abs = snapshotFilePath(v, f);
    if (!fs.existsSync(abs)) return res.status(500).json({ error: `版本快照缺失：${f.relPath}，无法交付` });
    const sha = await U.sha256File(abs);
    if (sha !== f.sha256) return res.status(500).json({ error: `版本快照与提交时不一致：${f.relPath}，已中止交付` });
  }

  const p = findProject(v.projectId);
  const delivery = {
    id: U.uuid(), projectId: v.projectId, versionId: v.id, receiverId: dev.id,
    status: 'running', error: null, savedTo: null,
    startedAt: Date.now(), finishedAt: null,
    files: v.files.map(f => ({ relPath: f.relPath, size: f.size, sha256: f.sha256, status: 'waiting', error: null })),
    projectFolder: p ? p.folder : '未知项目', versionLabel: v.label
  };
  data().deliveries.push(delivery); save();
  runDelivery(delivery.id).catch(() => { /* 错误已记录 */ });
  res.json({ delivery });
});

function statusText(s) {
  return { pending: '待审核', reviewing: '审核中', changes: '需要修改', approved: '已通过' }[s] || s;
}

async function runDelivery(deliveryId) {
  const ws = workspace(); if (!ws) return;
  const d = store.loadData(ws);
  const delivery = d.deliveries.find(x => x.id === deliveryId);
  if (!delivery) return;
  const v = d.versions.find(x => x.id === delivery.versionId);
  const dev = d.devices.find(x => x.id === delivery.receiverId);
  if (!v || !dev) return;

  deliveryProgress.set(deliveryId, { currentFile: null, currentBytes: 0, currentTotal: 0 });

  try {
    /* 通知接收端创建本次交付 */
    await postJson(receiverUrl(dev, '/api/deliveries'), {
      deliveryId: delivery.id,
      projectFolder: delivery.projectFolder,
      versionLabel: delivery.versionLabel,
      totalFiles: delivery.files.length,
      totalBytes: delivery.files.reduce((s, f) => s + f.size, 0)
    }, dev.receiverToken);

    for (const f of delivery.files) {
      f.status = 'sending'; save();
      deliveryProgress.set(deliveryId, { currentFile: f.relPath, currentBytes: 0, currentTotal: f.size });
      const abs = snapshotFilePath(v, f);
      await pushFile(dev, delivery.id, abs, f, deliveryId);
      f.status = 'done'; save();
    }

    const fin = await postJson(receiverUrl(dev, '/api/deliveries/' + delivery.id + '/finish'), {}, dev.receiverToken);
    delivery.status = 'done';
    delivery.savedTo = fin.savedTo || null;
    delivery.finishedAt = Date.now();
    save();
  } catch (e) {
    const cur = delivery.files.find(f => f.status === 'sending');
    if (cur) { cur.status = 'failed'; cur.error = e.message; }
    delivery.status = 'failed';
    delivery.error = e.message;
    delivery.finishedAt = Date.now();
    save();
  } finally {
    deliveryProgress.delete(deliveryId);
  }
}

/* 把单个文件流式推送到接收端，过程中更新进度 */
function pushFile(dev, deliveryId, absPath, f, progressKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(receiverUrl(dev, '/api/deliveries/' + deliveryId + '/file'));
    u.searchParams.set('rel', f.relPath);
    u.searchParams.set('sha256', f.sha256);
    u.searchParams.set('size', String(f.size));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'PUT', timeout: 15000,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': f.size,
        'x-receiver-token': dev.receiverToken || ''
      }
    }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch { /* 空 */ }
        if (r.statusCode >= 400) return reject(new Error(j.error || ('接收端拒绝（' + r.statusCode + '）')));
        resolve();
      });
    });
    req.on('timeout', () => req.destroy(new Error('传输超时')));
    req.on('error', e => reject(new Error(e.code === 'ECONNREFUSED' ? '接收端连接中断' : '传输中断：' + e.message)));
    const stream = fs.createReadStream(absPath);
    stream.on('data', chunk => {
      const pg = deliveryProgress.get(progressKey);
      if (pg) pg.currentBytes += chunk.length;
    });
    stream.on('error', e => { req.destroy(); reject(new Error('读取源文件失败：' + e.message)); });
    stream.pipe(req);
  });
}

app.get('/api/deliveries', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const list = data().deliveries.slice().sort((a, b) => b.startedAt - a.startedAt).map(deliveryDto);
  res.json({ deliveries: list });
});

app.get('/api/deliveries/:id', (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const d = data().deliveries.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '交付记录不存在' });
  res.json({ delivery: deliveryDto(d) });
});

function deliveryDto(d) {
  const live = deliveryProgress.get(d.id);
  const dev = data().devices.find(x => x.id === d.receiverId);
  return {
    ...d,
    receiverName: dev ? dev.name : '已移除设备',
    versionLabel: d.versionLabel,
    live: live || null
  };
}

/* 失败后重新交付（沿用同一记录） */
app.post('/api/deliveries/:id/retry', async (req, res) => {
  const ws = requireWorkspace(res); if (!ws) return;
  const d = data();
  const delivery = d.deliveries.find(x => x.id === req.params.id);
  if (!delivery) return res.status(404).json({ error: '交付记录不存在' });
  if (delivery.status === 'running') return res.status(400).json({ error: '该交付正在进行中' });
  const dev = findDevice(delivery.receiverId);
  if (!dev) return res.status(404).json({ error: '接收电脑已被移除' });
  await probeReceiver(dev);
  const live = receiverLive.get(dev.id);
  if (!live || !live.online) return res.status(400).json({ error: '接收电脑不在线：' + (live?.error || '无法连接') });
  delivery.status = 'running'; delivery.error = null; delivery.finishedAt = null;
  delivery.startedAt = Date.now();
  for (const f of delivery.files) { f.status = 'waiting'; f.error = null; }
  save();
  runDelivery(delivery.id).catch(() => {});
  res.json({ delivery: deliveryDto(delivery) });
});

/* ================= 总览 ================= */

app.get('/api/state', (req, res) => {
  const cfg = store.loadConfig();
  if (!cfg.workspace) return res.json({ workspace: null });
  const d = data();
  res.json({
    workspace: cfg.workspace,
    projects: d.projects.map(projectDto),
    devices: d.devices.map(deviceDto),
    deliveries: d.deliveries.slice().sort((a, b) => b.startedAt - a.startedAt).map(deliveryDto),
    commentCount: d.comments.length
  });
});

/* 启动时把中断的交付标记为失败（不能假装成功） */
(function fixInterrupted() {
  const cfg = store.loadConfig();
  if (!cfg.workspace) return;
  const d = store.loadData(cfg.workspace);
  let dirty = false;
  for (const del of d.deliveries) {
    if (del.status === 'running') {
      del.status = 'failed';
      del.error = '程序重启导致交付中断，可在创作者页面重新交付';
      del.finishedAt = Date.now();
      for (const f of del.files) if (f.status === 'sending' || f.status === 'waiting') { f.status = 'failed'; f.error = '中断'; }
      dirty = true;
    }
  }
  if (dirty) store.saveData(cfg.workspace);
})();

app.listen(PORT, '0.0.0.0', () => {
  const addrs = U.lanAddresses().map(a => `http://${a.address}:${PORT}`).join('  ');
  console.log('================================================');
  console.log('  局域网提审·审核·交付工具 —— 创作者主服务已启动');
  console.log('  创作者页面:  http://localhost:' + PORT);
  if (addrs) console.log('  局域网访问:  ' + addrs);
  console.log('================================================');
  /* 自动打开创作者页面 */
  const url = 'http://localhost:' + PORT;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
});
