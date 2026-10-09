import { readFile } from 'node:fs/promises';
const target = new URL(process.env.GALLERY_URL || 'http://127.0.0.1:3210');
if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('GALLERY_URL 应为图库服务的完整地址，例如 http://127.0.0.1:3210，不含账号、路径或参数。');
}
const base = target.origin;
if (target.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
  throw new Error('远程示例导入必须使用 HTTPS；HTTP 仅允许直接本机地址。');
}
const username = process.env.GALLERY_USERNAME;
const password = process.env.GALLERY_PASSWORD;
if (!username || !password) throw new Error('请先在软件中创建账号，再设置 GALLERY_USERNAME 和 GALLERY_PASSWORD 环境变量。');
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error('示例导入登录失败，请检查图库地址及账号密码。');
const cookie = login.headers.getSetCookie().find(value => value.startsWith('lumina_session='))?.split(';')[0];
if (!cookie) throw new Error('图库没有返回登录凭据，未导入示例。');
function galleryFetch(path, init = {}) {
  const url = new URL(path, base);
  if (url.origin !== base) throw new Error('示例导入只能访问指定的图库服务。');
  const headers = new Headers(init.headers);
  headers.set('Cookie', cookie);
  return fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(120_000) });
}
const samples = [
  { title: '湖畔来信 · 山野之间', category: '自然风光', description: '湖水映着远山，把时间留在这一刻。', tags: ['湖泊', '旅行', '治愈'], files: ['lake', 'coast'], favorite: true },
  { title: '日光漫过山脊', category: '自然风光', description: '奔赴旷野，遇见山间的第一束光。', tags: ['山野', '日光'], files: ['mountains', 'lake'], favorite: false },
  { title: '蓝调时分的城市', category: '城市漫游', description: '当天色暗下来，城市开始讲述故事。', tags: ['城市', '夜景'], files: ['city'], favorite: true },
  { title: '一场关于绿色的漫游', category: '自然风光', description: '沿着森林的小径，听见自然的呼吸。', tags: ['森林', '户外'], files: ['forest'], favorite: false },
  { title: '风与沙的形状', category: '灵感收藏', description: '风经过的地方，留下流动的线条。', tags: ['沙漠', '纹理', '灵感'], files: ['desert'], favorite: false },
  { title: '远方，是一片蔚蓝', category: '自然风光', description: '把晴朗的日子，装进相册里。', tags: ['湖畔', '假日'], files: ['coast'], favorite: false },
];
try {
  const response = await galleryFetch('/api/albums');
  if (!response.ok) throw new Error('无法读取图库，未导入示例。');
  const current = await response.json();
  if (!Array.isArray(current)) throw new Error('图库返回的数据格式不正确，未导入示例。');
  if (current.length) console.log('图库已有内容，跳过示例导入。');
  else for (const sample of samples) {
    const form = new FormData();
    form.append('metadata', JSON.stringify({ ...sample, links: [] }));
    for (const file of sample.files) form.append('images', new Blob([await readFile(new URL(`../public/demo/${file}.jpg`, import.meta.url))], {type:'image/jpeg'}), `${file}.jpg`);
    const response = await galleryFetch('/api/albums', {method:'POST',body:form});
    if (!response.ok) throw new Error(`示例导入失败（HTTP ${response.status}），请检查服务状态。`);
    console.log(`已导入示例：${sample.title}`);
  }
} finally {
  await galleryFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
}
