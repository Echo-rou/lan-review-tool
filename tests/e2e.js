'use strict';
/*
 * 端到端测试脚本（本机模拟三设备）
 * 运行前提：创作者主服务(8600) 与 接收端(8700) 已启动
 * 用法：node tests/e2e.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER = 'http://localhost:8600';
const RECEIVER = 'http://localhost:8700';
const WS = path.join(__dirname, 'tmp-workspace');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(base, url, opts = {}) {
  const r = await fetch(base + url, opts);
  let j = null;
  try { j = await r.json(); } catch { /* 文件流 */ }
  return { status: r.status, body: j, raw: r };
}
function post(base, url, body, headers = {}) {
  return api(base, url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
}
function sha256File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 生成真实测试素材：合法 PNG、合法 MP4(ftyp)、文本 */
function makeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8//8/AzGAiShVDAwMAAAA//8DAAD+/QHl1AAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(dir, '海报.png'), png);
  const ftyp = Buffer.alloc(32);
  ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4); ftyp.write('isom', 8);
  ftyp.writeUInt32BE(512, 12); ftyp.write('isomiso2mp41', 16);
  fs.writeFileSync(path.join(dir, '预告片.mp4'), Buffer.concat([ftyp, crypto.randomBytes(256 * 1024)]));
  fs.writeFileSync(path.join(dir, '文案.txt'), '第一版文案\n产品卖点：轻薄、长续航。\n口号：轻装上阵。', 'utf8');
  return ['海报.png', '预告片.mp4', '文案.txt'];
}

(async () => {
  console.log('== 0. 环境检查 ==');
  const si = await api(SERVER, '/api/server-info');
  ok('主服务在线', si.status === 200);
  const rs = await api(RECEIVER, '/api/local/state');
  ok('接收端在线', rs.status === 200);

  console.log('== 1. 设置工作区 ==');
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  let r = await post(SERVER, '/api/workspace', { path: WS });
  ok('选择工作区', r.status === 200, JSON.stringify(r.body));

  console.log('== 2. 创建项目 + 同名冲突 ==');
  r = await post(SERVER, '/api/projects', { date: '2026-07-18', brand: '测试品牌', name: '发布会视频' });
  ok('创建项目', r.status === 200 && r.body.project.folder === '2026-07-18_测试品牌_发布会视频', JSON.stringify(r.body));
  const project = r.body.project;
  ok('项目文件夹真实创建', fs.existsSync(path.join(WS, '2026-07-18_测试品牌_发布会视频')));
  r = await post(SERVER, '/api/projects', { date: '2026-07-18', brand: '测试品牌', name: '发布会视频' });
  ok('同名项目返回冲突(409)而非静默覆盖', r.status === 409);
  r = await post(SERVER, '/api/projects/adopt', { folder: '2026-07-18_测试品牌_发布会视频' });
  ok('冲突后可选择打开已有项目', r.status === 200);

  console.log('== 3. 准备待审文件 ==');
  const projDir = path.join(WS, project.folder);
  const names = makeAssets(projDir);
  r = await api(SERVER, '/api/projects/' + project.id + '/files');
  ok('项目文件列表读取', r.status === 200 && r.body.files.length === 3, '期望3个文件, 实际 ' + (r.body.files || []).length);

  console.log('== 4. 设备连接（手机模拟） ==');
  const pc = await api(SERVER, '/api/pairing/code');
  ok('获取配对码', pc.status === 200 && /^\d{6}$/.test(pc.body.code));
  r = await post(SERVER, '/api/join', { name: '导演的手机', code: '000000' });
  ok('错误配对码被拒绝', r.status === 400);
  r = await post(SERVER, '/api/join', { name: '导演的手机', code: pc.body.code });
  ok('手机请求连接', r.status === 200);
  const phoneId = r.body.deviceId;
  let st = await api(SERVER, '/api/join/status?deviceId=' + phoneId);
  ok('授权前状态为 pending', st.body.status === 'pending');
  r = await post(SERVER, '/api/devices/' + phoneId + '/approve');
  ok('创作者授权设备', r.status === 200);
  st = await api(SERVER, '/api/join/status?deviceId=' + phoneId);
  ok('手机获得访问凭证', st.body.status === 'approved' && !!st.body.token);
  const phoneToken = st.body.token;

  console.log('== 5. 未授权访问控制 ==');
  r = await api(SERVER, '/api/review/tasks');
  ok('无凭证访问被拒绝(401)', r.status === 401);
  r = await api(SERVER, '/api/review/tasks', { headers: { 'x-device-token': 'fake-token' } });
  ok('伪造凭证被拒绝(401)', r.status === 401);

  console.log('== 6. 提交 V01 ==');
  r = await post(SERVER, '/api/versions', { projectId: project.id, files: names, note: '初版，请重点看预告片', assignees: [phoneId] });
  ok('提交 V01', r.status === 200 && r.body.version.label === 'V01', JSON.stringify(r.body).slice(0, 200));
  const v1 = r.body.version;
  ok('V01 包含 3 个文件且带哈希', v1.files.length === 3 && v1.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));

  console.log('== 7. 手机端审核 V01 ==');
  r = await api(SERVER, '/api/review/tasks', { headers: { 'x-device-token': phoneToken } });
  ok('手机看到分配的任务', r.status === 200 && r.body.tasks.length === 1 && r.body.tasks[0].isCurrent === true);
  const video = v1.files.find(f => f.name === '预告片.mp4');
  const text = v1.files.find(f => f.name === '文案.txt');
  const img = v1.files.find(f => f.name === '海报.png');
  const fr = await fetch(SERVER + '/api/review/file/' + v1.id + '/' + video.id + '?token=' + phoneToken);
  ok('手机打开视频文件(200)', fr.status === 200, 'HTTP ' + fr.status);
  ok('视频 Content-Type 正确', (fr.headers.get('content-type') || '').includes('video/mp4'), fr.headers.get('content-type'));
  const buf = Buffer.from(await fr.arrayBuffer());
  ok('视频字节数一致', buf.length === video.size, buf.length + ' vs ' + video.size);
  const tr = await fetch(SERVER + '/api/review/file/' + v1.id + '/' + text.id + '?token=' + phoneToken);
  ok('手机打开文本文件(200)', tr.status === 200 && (await tr.text()).includes('第一版文案'));
  const ir = await fetch(SERVER + '/api/review/file/' + v1.id + '/' + img.id + '?token=' + phoneToken);
  ok('手机打开图片(200)', ir.status === 200 && (ir.headers.get('content-type') || '').includes('image/png'));
  const noAuth = await fetch(SERVER + '/api/review/file/' + v1.id + '/' + video.id);
  ok('无凭证打开文件被拒绝(401)', noAuth.status === 401);
  // Range 请求（视频拖动进度条）
  const rangeRes = await fetch(SERVER + '/api/review/file/' + v1.id + '/' + video.id + '?token=' + phoneToken, { headers: { Range: 'bytes=0-1023' } });
  ok('视频支持 Range 分段请求(206)', rangeRes.status === 206, 'HTTP ' + rangeRes.status);

  r = await post(SERVER, '/api/review/comments', { versionId: v1.id, fileId: video.id, text: '第5秒这里画面糊了', timecode: 5.2 }, { 'x-device-token': phoneToken });
  ok('添加时间码评论', r.status === 200 && r.body.comment.timecode === 5.2);
  r = await post(SERVER, '/api/review/comments', { versionId: v1.id, fileId: text.id, text: '口号再想想' }, { 'x-device-token': phoneToken });
  ok('添加普通评论', r.status === 200);
  r = await post(SERVER, '/api/review/mark', { versionId: v1.id, fileId: video.id, status: 'changes' }, { 'x-device-token': phoneToken });
  ok('标记「需要修改」', r.status === 200);

  console.log('== 8. 创作者看到反馈 ==');
  r = await api(SERVER, '/api/versions/' + v1.id);
  ok('创作者看到评论(含时间码)', r.status === 200 && r.body.comments.length === 2 && r.body.comments.some(c => c.timecode === 5.2));
  ok('V01 状态为需要修改', r.body.version.status === 'changes');

  console.log('== 9. 未通过版本禁止交付 ==');
  r = await post(SERVER, '/api/deliveries', { versionId: v1.id, receiverId: 'anyone' });
  ok('需要修改的版本不能交付', r.status === 400, 'HTTP ' + r.status);

  console.log('== 10. 修改工作文件并提交 V02 ==');
  fs.writeFileSync(path.join(projDir, '文案.txt'), '第二版文案\n口号：轻，不止是轻。', 'utf8');
  r = await post(SERVER, '/api/versions', { projectId: project.id, files: names, note: '修改版', assignees: [phoneId] });
  ok('提交 V02', r.status === 200 && r.body.version.label === 'V02');
  const v2 = r.body.version;
  const v1Check = await api(SERVER, '/api/versions/' + v1.id);
  ok('V01 评论与审核结果保留', v1Check.body.comments.length === 2 && v1Check.body.version.status === 'changes');
  const v1Text = v1.files.find(f => f.name === '文案.txt');
  const snapText = fs.readFileSync(path.join(WS, '.提审系统数据', 'snapshots', project.id, 'V01', '文案.txt'), 'utf8');
  ok('V01 快照未被后续修改影响', snapText.includes('第一版文案'));

  console.log('== 11. V02 全部审核通过 ==');
  for (const f of v2.files) {
    r = await post(SERVER, '/api/review/mark', { versionId: v2.id, fileId: f.id, status: 'approved' }, { 'x-device-token': phoneToken });
  }
  ok('全部文件标记通过', r.status === 200 && r.body.version.status === 'approved', r.body.version && r.body.version.status);

  console.log('== 12. 配对接收电脑 ==');
  r = await post(SERVER, '/api/receivers/pair', { addr: 'localhost:8700' });
  ok('发起接收端配对', r.status === 200 && !!r.body.requestId, JSON.stringify(r.body));
  const pairState = await api(RECEIVER, '/api/local/state');
  const pending = pairState.body.pendingPairs.find(p => p.requestId === r.body.requestId);
  ok('接收端屏幕显示确认码', !!pending && /^\d{4}$/.test(pending.code));
  r = await post(SERVER, '/api/receivers/confirm', { addr: 'http://localhost:8700', requestId: pending.requestId, code: pending.code });
  ok('确认码配对成功', r.status === 200 && r.body.device.role === 'receiver', JSON.stringify(r.body).slice(0, 200));
  const receiverId = r.body.device.id;
  await sleep(6000); // 等待一次探测心跳
  const devs = await api(SERVER, '/api/devices');
  const recvDev = devs.body.devices.find(d => d.id === receiverId);
  ok('接收电脑在线且能看到保存位置/剩余空间', recvDev.online === true && !!recvDev.receiverInfo, JSON.stringify(recvDev));

  console.log('== 13. 正式交付 V02 ==');
  r = await post(SERVER, '/api/deliveries', { versionId: v2.id, receiverId });
  ok('发起交付', r.status === 200 && r.body.delivery.status === 'running', JSON.stringify(r.body).slice(0, 200));
  const deliveryId = r.body.delivery.id;
  let dRec = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const dj = await api(SERVER, '/api/deliveries/' + deliveryId);
    dRec = dj.body.delivery;
    if (dRec.status !== 'running') break;
  }
  ok('交付完成', dRec && dRec.status === 'done', dRec && (dRec.status + ' ' + (dRec.error || '')));
  ok('返回了接收端保存位置', !!(dRec && dRec.savedTo), dRec && dRec.savedTo);
  if (dRec && dRec.savedTo) {
    let allMatch = true;
    for (const f of v2.files) {
      const dp = path.join(dRec.savedTo, f.relPath);
      if (!fs.existsSync(dp)) { allMatch = false; break; }
      const h = await sha256File(dp);
      if (h !== f.sha256) { allMatch = false; break; }
    }
    ok('接收到的文件与批准版本哈希完全一致', allMatch);
  }
  const recvState = await api(RECEIVER, '/api/local/state');
  ok('接收端也有交付记录', recvState.body.records.some(x => x.id === deliveryId && x.status === 'done'));

  console.log('== 14. 提审 ≠ 交付（隔离性） ==');
  ok('提审阶段文件没有提前进入接收目录',
    !fs.existsSync(path.join(dRec.savedTo, '..', '..', project.folder, 'V01')));

  console.log('== 15. 持久化验证（请随后手动重启主服务再跑一次 tests/verify-persistence.js） ==');
  ok('数据文件已写入磁盘', fs.existsSync(path.join(WS, '.提审系统数据', 'data.json')));

  console.log('\n========== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(1); });
