'use strict';
/* 负面路径测试：不能让产品"假装成功"的场景 */
const fs = require('fs');
const path = require('path');
const SERVER = 'http://localhost:8600';
const WS = path.join(__dirname, 'tmp-workspace');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(url, opts = {}) {
  const r = await fetch(SERVER + url, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}
function post(url, body, headers = {}) {
  return api(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
}

(async () => {
  const s = await api('/api/state');
  const project = s.body.projects[0];
  const v2 = project.versions.find(v => v.label === 'V02');
  const receiver = s.body.devices.find(d => d.role === 'receiver');
  const reviewer = s.body.devices.find(d => d.role === 'reviewer');

  console.log('== A. 越权与边界 ==');
  // 新建一台设备（授权）但不分配任务，访问 V02 应被拒绝
  const pc = await api('/api/pairing/code');
  const join = await post('/api/join', { name: '无关人员的手机', code: pc.body.code });
  await post('/api/devices/' + join.body.deviceId + '/approve');
  const st = await api('/api/join/status?deviceId=' + join.body.deviceId);
  const strangerToken = st.body.token;
  let r = await api('/api/review/versions/' + v2.id, { headers: { 'x-device-token': strangerToken } });
  ok('未分配的授权设备看不了该版本(403)', r.status === 403, 'HTTP ' + r.status);
  r = await api('/api/review/tasks', { headers: { 'x-device-token': strangerToken } });
  ok('未分配的设备任务列表为空', r.status === 200 && r.body.tasks.length === 0);
  // 取消授权后立即失去访问
  const join2 = await post('/api/join', { name: '被辞退的审核员', code: pc.body.code });
  await post('/api/devices/' + join2.body.deviceId + '/approve');
  const st2 = await api('/api/join/status?deviceId=' + join2.body.deviceId);
  await api('/api/devices/' + join2.body.deviceId, { method: 'DELETE' });
  r = await api('/api/review/tasks', { headers: { 'x-device-token': st2.body.token } });
  ok('取消授权后凭证立即失效(401)', r.status === 401, 'HTTP ' + r.status);

  console.log('== B. 提交校验 ==');
  r = await post('/api/versions', { projectId: project.id, files: [], assignees: [reviewer.id] });
  ok('空文件列表不能提交', r.status === 400);
  r = await post('/api/versions', { projectId: project.id, files: ['文案.txt'], assignees: [] });
  ok('没有审核设备不能提交', r.status === 400);
  r = await post('/api/versions', { projectId: project.id, files: ['../../etc/passwd'], assignees: [reviewer.id] });
  ok('路径穿越被拦截', r.status === 400, 'HTTP ' + r.status);

  console.log('== C. 快照被篡改 → 交付中止 ==');
  const snapDir = path.join(WS, '.提审系统数据', 'snapshots', project.id, 'V02');
  const victim = path.join(snapDir, '文案.txt');
  const original = fs.readFileSync(victim);
  fs.writeFileSync(victim, '被人偷偷改过的内容');
  r = await post('/api/deliveries', { versionId: v2.id, receiverId: receiver.id });
  ok('快照哈希不一致时拒绝交付', r.status === 500 && /不一致/.test(r.body.error || ''), JSON.stringify(r.body));
  fs.writeFileSync(victim, original); // 还原

  console.log('== D. 接收端离线 → 交付报明确错误 ==');
  const fake = await post('/api/receivers/pair', { addr: 'localhost:9999' });
  ok('连接不存在的接收端给出可读错误', fake.status === 400 && /连不上接收端/.test(fake.body.error || ''));

  console.log('\n========== 负面路径: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(1); });
