'use strict';
/* 持久化存储层：所有数据保存在工作区下的 .提审系统数据 目录，JSON 原子写入，重启后仍在 */
const path = require('path');
const fs = require('fs');
const { ensureDir } = require('./util');

const APP_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(APP_DIR, 'app-config.json');
const SYS_DIR_NAME = '.提审系统数据';

ensureDir(APP_DIR);

/* ---------- 应用级配置（记住工作区选择） ---------- */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { workspace: null }; }
}
function saveConfig(cfg) {
  atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function atomicWrite(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/* ---------- 业务数据（跟随工作区） ---------- */
const EMPTY = () => ({
  projects: [],    // {id,date,brand,name,folder,createdAt}
  versions: [],    // {id,projectId,label,note,createdAt,files:[{id,relPath,name,size,kind,sha256}],assignees:[deviceId]}
  devices: [],     // {id,name,role:'reviewer'|'receiver',token,approved,addr,receiverToken,createdAt,lastSeen,lastUserAgent}
  comments: [],    // {id,versionId,fileId,deviceId,author,text,timecode,createdAt}
  reviews: [],     // {versionId,fileId,status:'changes'|'approved',deviceId,updatedAt}
  deliveries: []   // {id,projectId,versionId,receiverId,status,error,savedTo,startedAt,finishedAt,files:[{relPath,size,sha256,status,error}]}
});

let cache = null;
let cacheWorkspace = null;

function sysDir(workspace) { return path.join(workspace, SYS_DIR_NAME); }
function dataFile(workspace) { return path.join(sysDir(workspace), 'data.json'); }
function snapshotRoot(workspace) { return path.join(sysDir(workspace), 'snapshots'); }

function loadData(workspace) {
  if (cache && cacheWorkspace === workspace) return cache;
  const file = dataFile(workspace);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = EMPTY();
    for (const k of Object.keys(base)) if (!Array.isArray(data[k])) data[k] = base[k];
  } catch {
    data = EMPTY();
  }
  cache = data;
  cacheWorkspace = workspace;
  return data;
}

function saveData(workspace) {
  if (!cache || cacheWorkspace !== workspace) return;
  ensureDir(snapshotRoot(workspace));
  atomicWrite(dataFile(workspace), JSON.stringify(cache, null, 2));
}

/* 工作区切换时清空缓存 */
function resetCache() { cache = null; cacheWorkspace = null; }

/* ---------- 派生状态计算 ---------- */
/* 某个版本的整体状态：pending(待审核) / reviewing(审核中) / changes(需要修改) / approved(已通过可交付) */
function versionStatus(data, version) {
  const rs = data.reviews.filter(r => r.versionId === version.id);
  if (!rs.length) return 'pending';
  const byFile = {};
  for (const r of rs) byFile[r.fileId] = r.status;
  const total = version.files.length;
  let approved = 0, changes = 0;
  for (const f of version.files) {
    const st = byFile[f.id];
    if (st === 'approved') approved++;
    else if (st === 'changes') changes++;
  }
  if (changes > 0) return 'changes';
  if (approved === total && total > 0) return 'approved';
  return 'reviewing';
}

function nextVersionLabel(data, projectId) {
  const n = data.versions.filter(v => v.projectId === projectId).length;
  return 'V' + String(n + 1).padStart(2, '0');
}

module.exports = {
  SYS_DIR_NAME, loadConfig, saveConfig,
  loadData, saveData, resetCache,
  sysDir, snapshotRoot, versionStatus, nextVersionLabel
};
