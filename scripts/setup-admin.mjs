import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

async function main() {
  if (process.argv.length > 2) throw new Error('此脚本不接受命令行参数；请在提示后输入账号和密码。');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互式终端运行；Docker 请使用 docker compose exec lumina node scripts/setup-admin.mjs。');
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数。');
  const base = `http://127.0.0.1:${port}`;
  const request = (path, init = {}) => fetch(`${base}/api/auth/${path}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const statusResponse = await request('status');
  if (!statusResponse.ok) throw new Error('无法读取图库登录状态，请先启动图库服务。');
  const status = await statusResponse.json();
  if (status.configured === true) {
    process.stdout.write('图库账号已设置，本脚本不会覆盖账号或重置密码。请在网页中登录。\n');
    return;
  }
  if (status.configured !== false || status.setupAllowed !== true) throw new Error('当前服务不允许初始化，请在图库所在服务器或容器的终端运行。');

  let hidden = true;
  const terminalOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const reader = createInterface({ input: process.stdin, output: terminalOutput, terminal: true, historySize: 0 });
  function ask(prompt, secret = false) {
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error('已取消，未完成账号初始化。')); };
      const cleanup = () => { reader.off('SIGINT', abort); reader.off('close', abort); };
      reader.once('SIGINT', abort); reader.once('close', abort);
      if (secret) process.stdout.write(prompt);
      hidden = secret;
      reader.question(secret ? '' : prompt, answer => {
        // Keep input muted between questions, including the remainder of a pasted chunk.
        cleanup(); hidden = true;
        if (secret) process.stdout.write('\n');
        resolve(answer);
      });
    });
  }

  let password = '', confirmation = '';
  try {
    process.stdout.write('创建图库管理员。密码输入时不会显示，也不会写入命令行历史。\n');
    const username = (await ask('用户名（2–40 个字符）：')).trim();
    password = await ask('密码（15–128 个字符，建议使用长密码短语，输入不显示）：', true);
    confirmation = await ask('再次输入密码：', true);
    if (password !== confirmation) throw new Error('两次密码不一致，未创建账号。');
    if (username.length < 2 || username.length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(username)) throw new Error('用户名需要 2–40 个字符，不能包含控制字符。');
    if (password.length < 15 || password.length > 128 || !password.trim()) throw new Error('密码需要 15–128 个字符，且不能全部为空格。');
    const response = await request('setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
      if (response.status === 409) throw new Error('账号已经在其他窗口中创建；本脚本不会覆盖，请直接登录。');
      const result = await response.json().catch(() => null);
      if (response.status === 400 && typeof result?.error === 'string' && result.error.length <= 512) throw new Error(result.error);
      throw new Error(`初始化未完成（HTTP ${response.status}），请检查服务状态后重试。`);
    }
    // Setup creates a session for its caller; discard this CLI-only session immediately.
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('lumina_session='))?.split(';')[0];
    if (cookie) await request('logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' }).catch(() => undefined);
    process.stdout.write('图库账号创建成功。请返回浏览器，使用刚设置的账号密码登录。\n');
  } finally {
    password = ''; confirmation = ''; hidden = false;
    reader.close(); terminalOutput.end();
  }
}

main().catch(error => {
  const message = error instanceof Error && error.name !== 'TypeError' && error.name !== 'TimeoutError'
    ? error.message : '无法连接本机图库服务，请确认服务已启动且 PORT 设置正确。';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
