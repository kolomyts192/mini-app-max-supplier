// Загрузка официальных открытых данных через локальный Chrome (DevTools Protocol), когда сервер выходит в интернет
// через VPN, а chrome.exe исключён из туннеля. Chrome запускается на хосте:
//   chrome.exe --headless=new --user-data-dir=<временная папка> --remote-debugging-port=9333 --remote-allow-origins=* about:blank
// Команды (из контейнера tools):
//   node scripts/chrome-fetch.mjs links <url>                 — ссылки страницы (href и текст)
//   node scripts/chrome-fetch.mjs text <url>                  — видимый текст страницы
//   node scripts/chrome-fetch.mjs get <url>                   — тело ответа (для небольших CSV/JSON/HTML)
//   node scripts/chrome-fetch.mjs download <url> <папка хоста> — скачать файл в папку на хосте (путь Windows)
import dns from 'node:dns/promises';
import http from 'node:http';

const PORT = Number(process.env.CHROME_CDP_PORT ?? 9333);
const HOST = process.env.CHROME_CDP_HOST ?? 'host.docker.internal';

function getJson(host, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port: PORT, path, headers: { Host: `localhost:${PORT}` }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`${res.statusCode} ${body}`))));
    });
    req.on('error', reject);
  });
}

async function connect() {
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(HOST) ? HOST : (await dns.lookup(HOST)).address;
  const version = await getJson(ip, '/json/version');
  const ws = new WebSocket(version.webSocketDebuggerUrl.replace(/127\.0\.0\.1|localhost/, ip));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Не удалось подключиться к Chrome DevTools'));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const waitFor = (pred, timeoutMs) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        listeners.delete(l);
        reject(new Error('timeout'));
      }, timeoutMs);
      const l = (msg) => {
        if (pred(msg)) {
          clearTimeout(t);
          listeners.delete(l);
          resolve(msg);
        }
      };
      listeners.add(l);
    });
  return { ws, send, waitFor };
}

async function openPage(cdp, url, timeoutMs = 60_000) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  const loaded = cdp.waitFor((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', timeoutMs).catch(() => null);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  return { targetId, sessionId, evaluate, close: () => cdp.send('Target.closeTarget', { targetId }) };
}

async function main() {
  const [cmd, url, dest] = process.argv.slice(2);
  if (!cmd || !url) throw new Error('Использование: chrome-fetch.mjs links|text|get|download <url> [папка]');
  const cdp = await connect();
  try {
    if (cmd === 'watch' || cmd === 'cancel') {
      // watch <папка>: прогресс текущих загрузок; cancel <guid>: отменить загрузку
      if (cmd === 'cancel') {
        await cdp.send('Browser.cancelDownload', { guid: url });
        console.log(`canceled ${url}`);
        return;
      }
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: url, eventsEnabled: true });
      const p = (await cdp.waitFor((m) => m.method === 'Browser.downloadProgress', 15_000)).params;
      console.log(`${p.guid} ${p.state} ${Math.round(p.receivedBytes / 1048576)} MB из ${Math.round(p.totalBytes / 1048576)} MB`);
      return;
    }
    if (cmd === 'download') {
      if (!dest) throw new Error('Укажите папку на хосте для download');
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dest, eventsEnabled: true });
      const begin = cdp.waitFor((m) => m.method === 'Browser.downloadWillBegin', 120_000);
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const b = (await begin).params;
      console.log(`download started: ${b.suggestedFilename} (${b.guid})`);
      let last = 0;
      for (;;) {
        const p = (await cdp.waitFor((m) => m.method === 'Browser.downloadProgress' && m.params.guid === b.guid, 6 * 3600_000)).params;
        if (p.state === 'completed') {
          console.log(`completed: ${dest}\\${b.suggestedFilename} (${p.receivedBytes} bytes)`);
          break;
        }
        if (p.state === 'canceled') throw new Error('download canceled');
        const mb = Math.floor(p.receivedBytes / 1048576);
        if (mb - last >= 50) {
          last = mb;
          console.log(`… ${mb} MB${p.totalBytes ? ` из ${Math.round(p.totalBytes / 1048576)} MB` : ''}`);
        }
      }
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      return;
    }
    // get: страница того же домена (robots.txt грузится быстро), затем fetch — без CORS и без скачивания файла
    const page = await openPage(cdp, cmd === 'get' || cmd === 'sizes' ? `${new URL(url).origin}/robots.txt` : url);
    try {
      if (cmd === 'links') {
        const links = await page.evaluate(`[...document.querySelectorAll('a[href]')].map(a => a.href + '\\t' + a.textContent.replace(/\\s+/g,' ').trim().slice(0,120)).join('\\n')`);
        console.log(links);
      } else if (cmd === 'text') {
        console.log(await page.evaluate('document.body ? document.body.innerText : document.documentElement.outerHTML'));
      } else if (cmd === 'get') {
        const out = await page.evaluate(`(async () => {
          try {
            const r = await fetch(${JSON.stringify(url)});
            const buf = await r.arrayBuffer();
            let text = new TextDecoder('utf-8').decode(buf);
            if ((text.match(/\\uFFFD/g) || []).length > 2) text = new TextDecoder('windows-1251').decode(buf);
            return r.status + ' ' + (r.headers.get('content-type') || '') + ' ' + buf.byteLength + ' bytes\\n\\n' + text;
          } catch (e) { return 'ERROR ' + e.message; }
        })()`);
        console.log(out);
      } else if (cmd === 'sizes') {
        // sizes <url> <url2,url3,...>: размер файлов по заголовку Content-Length (HEAD)
        const list = [url, ...(dest ? dest.split(',') : [])];
        // Размер из Content-Range ответа на запрос первого байта (HEAD на части сайтов не возвращает длину)
        console.log(await page.evaluate(`(async () => { const out = []; for (const u of ${JSON.stringify(list)}) {
            try { const c = new AbortController(); const r = await fetch(u, { headers: { Range: 'bytes=0-0' }, signal: c.signal });
              const total = (r.headers.get('content-range') || '').split('/')[1] || r.headers.get('content-length') || '0'; c.abort();
              out.push((Math.round(Number(total) / 1048576 * 10) / 10) + ' MB  ' + u); } catch (e) { out.push('ERR ' + u + ' ' + e.message); } }
          return out.join('\\n'); })()`));
      } else throw new Error(`Неизвестная команда ${cmd}`);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    cdp.ws.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
