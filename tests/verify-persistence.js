'use strict';
/* 重启主服务后运行：验证项目、版本、设备、评论、审核结果、交付记录仍然存在 */
const SERVER = 'http://localhost:8600';
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(url) {
  const r = await fetch(SERVER + url);
  return { status: r.status, body: await r.json().catch(() => null) };
}
(async () => {
  const s = await api('/api/state');
  ok('主服务在线', s.status === 200);
  if (!s.body || !s.body.workspace) { console.log('工作区为空：请确认已用原工作区重启'); process.exit(1); }
  ok('工作区选择被记住', s.body.workspace.includes('tmp-workspace'), s.body.workspace);
  ok('项目仍在', s.body.projects.length >= 1, '数量 ' + s.body.projects.length);
  const p = s.body.projects[0];
  ok('两个版本都在', p.versions.length === 2, '数量 ' + p.versions.length);
  ok('V01 评论保留', p.versions.find(v => v.label === 'V01') && p.versions.find(v => v.label === 'V01').commentCount === 2);
  ok('V02 审核通过状态保留', p.versions.find(v => v.label === 'V02') && p.versions.find(v => v.label === 'V02').status === 'approved');
  ok('设备授权保留', s.body.devices.some(d => d.approved && d.role === 'reviewer'));
  ok('接收电脑配对保留', s.body.devices.some(d => d.role === 'receiver'));
  ok('交付记录保留', s.body.deliveries.length >= 1 && s.body.deliveries[0].status === 'done');
  console.log('\n========== 持久化: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
