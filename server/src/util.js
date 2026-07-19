'use strict';
/* 通用工具：路径安全、哈希、文件类型、格式化 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function uuid() { return crypto.randomUUID(); }

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/* 防止路径穿越：把用户输入的相对路径限制在 root 之内，越界返回 null */
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const normalized = path.normalize(rel).replace(/^([/\\])+/, '');
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  const abs = path.resolve(root, normalized);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

const KIND_MAP = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'flv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml', 'srt', 'html', 'css', 'js'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz']
};

function fileKind(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [kind, exts] of Object.entries(KIND_MAP)) {
    if (exts.includes(ext)) return kind;
  }
  return 'other';
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  m4v: 'video/mp4', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  csv: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', srt: 'text/plain; charset=utf-8',
  xml: 'text/xml; charset=utf-8', html: 'text/html; charset=utf-8'
};

function mimeOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* 递归列出目录下所有文件（相对路径） */
function walkFiles(rootAbs, rel = '') {
  const out = [];
  const dir = rel ? path.join(rootAbs, rel) : rootAbs;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walkFiles(rootAbs, childRel));
    else if (e.isFile()) {
      try {
        const st = fs.statSync(path.join(rootAbs, childRel));
        out.push({ relPath: childRel, name: e.name, size: st.size, mtime: st.mtimeMs });
      } catch { /* 忽略读不到的文件 */ }
    }
  }
  return out;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/* 获取本机局域网 IPv4 地址列表 */
function lanAddresses() {
  const os = require('os');
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

module.exports = { uuid, sha256File, safeJoin, fileKind, mimeOf, formatSize, walkFiles, ensureDir, lanAddresses };
