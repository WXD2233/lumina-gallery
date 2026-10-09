import test from 'node:test';
import assert from 'node:assert/strict';
import { BaiduShareError, checkBaiduLink, inspectBaiduShare } from './baidu.ts';

const SHARE = 'https://pan.baidu.com/s/1exampleShare';
const PAGE = '<html><title>百度网盘分享</title><script>window.yunData={share_uk:"1234",shareid:"5678"};</script></html>';
const CODE_PAGE = '<html><title>百度网盘 请输入提取码</title><script>window.yunData={uk:"0",share_uk:"1234",shareid:"5678"};</script></html>';
const file = (path: string, seconds = 1_700_000_000) => ({ path, isdir: 0, server_mtime: seconds });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function sequence(responses: (Response | ((url: URL, init: RequestInit) => Response))[]) {
  let calls = 0;
  const fetchImpl = (async (value: string | URL | Request, init: RequestInit = {}) => {
    assert.equal(init.redirect, 'manual');
    const next = responses[calls++];
    assert.ok(next, 'Unexpected extra network call');
    return typeof next === 'function' ? next(new URL(String(value)), init) : next;
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test('uses only actual file server_mtime, recursing directories; never header or folder time', async () => {
  const transport = sequence([
    new Response(PAGE, { headers: { Date: 'Fri, 01 Jan 2038 00:00:00 GMT', 'Last-Modified': 'Fri, 01 Jan 2038 00:00:00 GMT' } }),
    json({ errno: 0, list: [file('/a.jpg'), { path: '/nested', isdir: 1, server_mtime: 2_000_000_000 }] }),
    (url) => {
      assert.equal(url.searchParams.get('dir'), '/nested');
      assert.equal(url.searchParams.get('root'), '0');
      return json({ errno: 0, list: [file('/nested/new.jpg', 1_710_000_000)] });
    },
  ]);
  const result = await inspectBaiduShare({ url: SHARE }, transport);
  assert.equal(result.fileCount, 2);
  assert.equal(result.updatedAt, new Date(1_710_000_000 * 1000).toISOString());
});

test('share/init preserves a leading 1 in surl and submits code in body, maintaining cookies', async () => {
  const transport = sequence([
    (url) => {
      assert.equal(url.pathname, '/s/11exampleShare');
      return new Response(CODE_PAGE, { headers: { 'Set-Cookie': 'PANPSC=initial; Path=/; Secure' } });
    },
    (url, init) => {
      assert.equal(url.searchParams.get('surl'), '1exampleShare');
      assert.equal(url.pathname, '/share/verify');
      assert.match(String(init.body), /pwd=abcd/);
      assert.equal(new Headers(init.headers).get('Cookie'), 'PANPSC=initial');
      return json({ errno: 0, randsk: 'secret%2Fvalue' });
    },
    (_url, init) => {
      assert.match(new Headers(init.headers).get('Cookie') ?? '', /BDCLND=secret%2Fvalue/);
      return new Response(PAGE);
    },
    (url) => {
      assert.equal(url.searchParams.get('sekey'), 'secret/value');
      return json({ errno: 0, list: [file('/photo.jpg')] });
    },
  ]);
  const result = await inspectBaiduShare({ url: 'https://pan.baidu.com/share/init?surl=1exampleShare#list/path=%2F', code: 'abcd' }, transport);
  assert.equal(result.fileCount, 1);
  assert.equal(transport.calls(), 4);
});

test('lists all pages and honors explicit has_more even for a short page', async () => {
  const transport = sequence([
    new Response(PAGE),
    json({ errno: 0, list: [file('/old')], has_more: 1, total: 2 }),
    (url) => {
      assert.equal(url.searchParams.get('page'), '2');
      return json({ errno: 0, list: [file('/new', 1_720_000_000)], has_more: 0, total: 2 });
    },
  ]);
  assert.equal((await inspectBaiduShare({ url: SHARE }, transport)).fileCount, 2);
});

test('without has_more requests another page after a full page', async () => {
  const transport = sequence([
    new Response(PAGE),
    json({ errno: 0, list: Array.from({ length: 100 }, (_, i) => file(`/file-${i}`)) }),
    json({ errno: 0, list: [file('/latest', 1_720_000_000)] }),
  ]);
  assert.equal((await inspectBaiduShare({ url: SHARE }, transport)).fileCount, 101);
});

test('rejects all non-Baidu URLs and non-HTTPS links before networking', async () => {
  for (const url of ['http://pan.baidu.com/s/1abcde', 'https://127.0.0.1/s/1abcde', 'https://pan.baidu.com.evil.test/s/1abcde', 'https://evil:pass@pan.baidu.com/s/1abcde', 'https://pan.baidu.com:8443/s/1abcde']) {
    const transport = sequence([]);
    await assert.rejects(inspectBaiduShare({ url }, transport), /HTTPS/);
    assert.equal(transport.calls(), 0);
  }
});

test('rejects redirects to untrusted hosts without forwarding cookies', async () => {
  const transport = sequence([new Response(null, { status: 302, headers: { Location: 'https://example.com/private' } })]);
  await assert.rejects(inspectBaiduShare({ url: SHARE, cookie: 'BDUSS=very-private' }, transport), /仅允许/);
  assert.equal(transport.calls(), 1);
});

test('network failures expose only typed safe messages, never upstream credentials', async () => {
  const fetchImpl = (async () => { throw new Error('BDUSS=private-cookie; code=abcd'); }) as typeof fetch;
  await assert.rejects(inspectBaiduShare({ url: SHARE }, { fetchImpl }), (error) => {
    assert.ok(error instanceof BaiduShareError);
    assert.match(error.message, /无法连接/);
    assert.doesNotMatch(error.message, /private-cookie|abcd/);
    return true;
  });
});

test('reports login redirect, required code, incorrect code, captcha and expired shares', async () => {
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([
    new Response(null, { status: 302, headers: { Location: 'https://passport.baidu.com/login' } }),
  ])), /要求登录/);
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([new Response(CODE_PAGE)])), /需要提取码/);
  await assert.rejects(inspectBaiduShare({ url: SHARE, code: 'abcd' }, sequence([new Response(CODE_PAGE), json({ errno: -9 })])), /提取码错误/);
  await assert.rejects(inspectBaiduShare({ url: SHARE, code: 'abcd' }, sequence([new Response(CODE_PAGE), json({ errno: -62, vcode: 'required' })])), /安全验证/);
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([new Response('<title>分享已失效</title>')])), /失效/);
});

test('missing file modification time never falls back to creation time or check time', async () => {
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([
    new Response(PAGE), json({ errno: 0, list: [{ path: '/a', isdir: 0, server_ctime: 1_730_000_000, local_mtime: 1_740_000_000 }] }),
  ])), /缺少有效修改时间/);
});

test('a failed nested directory makes the entire inspection fail', async () => {
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([
    new Response(PAGE), json({ errno: 0, list: [file('/valid'), { path: '/private', isdir: 1 }] }), json({ errno: -6 }),
  ])), /登录/);
});

test('detects truncated or duplicated pages, HTML challenges and absent lists', async () => {
  const invalid = [
    json({ errno: 0, list: [file('/a')], total: 2, has_more: 0 }),
    json({ errno: 0, list: [] , has_more: 1 }),
    json({ errno: 0, list: [file('/a'), file('/a')] }),
    json({ errno: 0 }),
    new Response('<html>Please log in</html>'),
  ];
  for (const response of invalid) await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([new Response(PAGE), response])));
});

test('refuses oversized response and empty shares', async () => {
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([new Response(PAGE, { headers: { 'Content-Length': String(8 * 1024 * 1024) } })])), /响应过大/);
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([new Response(PAGE), json({ errno: 0, list: [] })])), /没有可读取/);
});

test('fails instead of silently truncating scans at the page limit', async () => {
  let count = 0;
  const fetchImpl = (async () => {
    if (count++ === 0) return new Response(PAGE);
    return json({ errno: 0, list: [file(`/unique-${count}`)], has_more: 1 });
  }) as typeof fetch;
  await assert.rejects(inspectBaiduShare({ url: SHARE }, { fetchImpl }), /超过 500 页/);
  assert.equal(count, 501);
});

test('link health reads only the first root page, without requiring timestamps or traversing folders', async () => {
  for (const list of [[], [{ path: '/folder', isdir: 1 }, { path: '/no-timestamp.jpg', isdir: 0 }]]) {
    const transport = sequence([new Response(PAGE), (url) => {
      assert.equal(url.pathname, '/share/list');
      assert.equal(url.searchParams.get('page'), '1');
      assert.equal(url.searchParams.get('root'), '1');
      return json({ errno: 0, list, has_more: 1 });
    }]);
    const result = await checkBaiduLink({ url: SHARE }, transport);
    assert.equal(result.status, 'valid');
    assert.equal(transport.calls(), 2);
  }
});

test('health distinguishes expired pages from code, login, verification and unknown errors', async () => {
  const cases = [
    { status: 'invalid', responses: [new Response('<title>分享已失效</title>')] },
    { status: 'invalid', responses: [new Response('<title>百度网盘</title><main>啊哦，你来晚了，分享的文件已经被取消了。</main>')] },
    { status: 'invalid', responses: [new Response('<title>百度网盘</title><main>啊哦，你来晚了，分享的文件已经被删除了，下次要早点哟。</main>')] },
    { status: 'invalid', responses: [new Response(PAGE), json({ errno: -7, errmsg: '分享链接已过期' })] },
    { status: 'invalid', code: 'abcd', responses: [new Response(CODE_PAGE), json({ errno: -9, errmsg: '分享链接已取消' })] },
    { status: 'code_required', responses: [new Response(CODE_PAGE)] },
    { status: 'code_error', code: 'abcd', responses: [new Response(CODE_PAGE), json({ errno: -9 })] },
    { status: 'login_required', responses: [new Response(null, { status: 302, headers: { Location: 'https://passport.baidu.com/login' } })] },
    { status: 'login_required', responses: [new Response(PAGE), json({ errno: -6 })] },
    { status: 'login_required', responses: [new Response('<title>登录百度账号</title>')] },
    { status: 'login_required', responses: [new Response('<main>请先登录后查看分享</main>')] },
    { status: 'login_required', responses: [new Response(null, { status: 401 })] },
    { status: 'verification_required', responses: [new Response('<title>安全验证</title>')] },
    { status: 'verification_required', responses: [new Response('<main>请输入验证码</main>')] },
    { status: 'verification_required', responses: [new Response(null, { status: 403 })] },
    { status: 'verification_required', responses: [new Response(null, { status: 429 })] },
    { status: 'verification_required', code: 'abcd', responses: [new Response(CODE_PAGE), json({ errno: -62, vcode: 'required' })] },
    { status: 'unknown', responses: [new Response('<title>百度网盘</title><p>页面结构发生变化</p>')] },
    { status: 'unknown', responses: [new Response(PAGE), json({ errno: -7 })] },
    { status: 'unknown', responses: [new Response(PAGE), json({ errno: 115 })] },
    { status: 'unknown', responses: [new Response(PAGE), json({ errno: -99999 })] },
    { status: 'unknown', responses: [new Response(PAGE), json({ errno: 0 })] },
    { status: 'unknown', responses: [new Response(null, { status: 404 })] },
    { status: 'network_error', responses: [new Response(null, { status: 503 })] },
  ];
  for (const fixture of cases) {
    const result = await checkBaiduLink({ url: SHARE, code: fixture.code }, sequence(fixture.responses));
    assert.equal(result.status, fixture.status, result.message);
  }
});

test('health does not mistake filenames, scripts or stale error translations for expiry', async () => {
  const transport = sequence([
    new Response(PAGE.replace('百度网盘分享', '分享链接已失效.jpg - 百度网盘').replace('</html>', '<span>分享链接已失效.jpg</span></html>')),
    json({ errno: 0, list: [file('/分享链接已失效.jpg')] }),
  ]);
  assert.equal((await checkBaiduLink({ url: SHARE }, transport)).status, 'valid');
  const scriptOnly = sequence([new Response('<title>百度网盘</title><script>const expiredMessage="分享链接已失效";</script>')]);
  assert.equal((await checkBaiduLink({ url: SHARE }, scriptOnly)).status, 'unknown');
});

test('health network failures and rejected redirects never disclose or forward credentials', async () => {
  const failed = (async () => { throw new Error('BDUSS=private-cookie; code=abcd'); }) as typeof fetch;
  const result = await checkBaiduLink({ url: SHARE }, { fetchImpl: failed });
  assert.equal(result.status, 'network_error');
  assert.doesNotMatch(result.message, /private-cookie|abcd/);
  const transport = sequence([new Response(null, { status: 302, headers: { Location: 'https://example.com/private' } })]);
  assert.equal((await checkBaiduLink({ url: SHARE, cookie: 'BDUSS=private-cookie' }, transport)).status, 'unsupported');
  assert.equal(transport.calls(), 1);
});

test('timestamp scan failures preserve successful root availability proof', async () => {
  const responses = [
    [new Response(PAGE), json({ errno: 0, list: [] })],
    [new Response(PAGE), json({ errno: 0, list: [{ path: '/photo.jpg', isdir: 0 }] })],
    [new Response(PAGE), json({ errno: 0, list: [{ path: '/private', isdir: 1 }] }), json({ errno: -6 })],
    [new Response(PAGE), json({ errno: 0, list: [file('/a')], total: 2, has_more: 0 })],
  ];
  for (const fixture of responses) await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence(fixture)), (error) => {
    assert.ok(error instanceof BaiduShareError);
    assert.equal(error.healthStatus, 'valid');
    return true;
  });
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([new Response(PAGE), json({ errno: -6 })])), (error) => {
    assert.ok(error instanceof BaiduShareError);
    assert.equal(error.healthStatus, 'login_required');
    return true;
  });
});

test('external cancellation reaches the request and prevents further scan work', async () => {
  const abort = new AbortController();
  let started!: () => void, observed: AbortSignal | undefined, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fetchImpl = (async (_value, init) => {
    calls++; observed = init?.signal as AbortSignal; started();
    return new Promise<Response>((_resolve, reject) => observed!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }) as typeof fetch;
  const running = inspectBaiduShare({ url: SHARE, signal: abort.signal }, { fetchImpl });
  await ready; abort.abort();
  await assert.rejects(running, /已取消/);
  assert.equal(observed?.aborted, true);
  assert.equal(calls, 1);
});

test('rejected response URLs and excessive cookies cancel their unread bodies', async () => {
  for (const kind of ['url', 'cookie']) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const response = new Response(body, { headers: kind === 'cookie' ? { 'Set-Cookie': `token=${'a'.repeat(33_000)}` } : undefined });
    if (kind === 'url') Object.defineProperty(response, 'url', { value: 'https://example.com/rejected' });
    await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([response])), kind === 'url' ? /仅允许/ : /Cookie 过多/);
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  }
});

test('excessive streamed bodies release their reader and directory keys are bounded', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); } }));
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([response])), /响应过大/);
  assert.equal(response.body?.locked, false);
  await assert.rejects(inspectBaiduShare({ url: SHARE }, sequence([new Response(PAGE), json({ errno: 0, list: [file(`/${'a'.repeat(8192)}`)] })])), /名称数据过大/);
});
