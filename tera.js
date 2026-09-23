#!/usr/bin/env node
/**
 * tera.js — TeraBox / 1024TeraBox share downloader.
 *
 * Usage:
 *   node tera.js "https://1024terabox.com/s/1bFCiXEabO1zgEnlPt87dgA"   # recurse & download everything
 *   node tera.js <url> --out /path/to/dir                            # custom output dir
 *
 * No login. Uses the unauthenticated web-share API (app_id=250528, PANWEB=1).
 * Flow per share: resolve shorturl -> recurse share/list for every entry -> share/download for dlink.
 *
 * Honest limitations (the API enforces these server-side; no scraper gets around them):
 *   - No CAPTCHA solving. If a share is gated (errno 400310 / 400141, or a reCAPTCHA
 *     iframe in the page), files are listed but their dlinks stay locked. The link
 *     typically also needs an extract code (pwd).
 *   - Expired / region-blocked / reported shares return errno!=0 and yield nothing.
 */
'use strict';

const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const APP_ID = '250528';
const HOSTS = ['https://www.1024tera.com', 'https://www.1024terabox.com'];
let HOST = HOSTS[0];
let COOKIE = { PANWEB: '1' };

function cookieToHeader() {
  return Object.entries(COOKIE)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// Visit the share page once (following redirects) and keep every cookie it sets
// (TSID, browserid, PANWEB). The share/list API returns errno:2 unless it sees them.
function primeCookies(pageUrl, maxHops = 5) {
  return new Promise((resolve, reject) => {
    const fetchOnce = (url, hops) => {
      const u = new URL(url);
      const req = https.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            'User-Agent': UA,
            'Accept-Language': 'en-US,en;q=0.9',
            Cookie: cookieToHeader(),
          },
        },
        (res) => {
          for (const c of res.headers['set-cookie'] || []) {
            const m = /^([^=]+)=([^;]*)/.exec(c);
            if (m) COOKIE[m[1]] = m[2];
          }
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
            res.resume();
            return fetchOnce(new URL(res.headers.location, url).href, hops - 1);
          }
          res.resume();
          res.on('end', () => {
            if (!COOKIE.PANWEB) COOKIE.PANWEB = '1';
            resolve();
          });
        }
      );
      req.on('error', reject);
    };
    fetchOnce(pageUrl, maxHops);
  });
}

function apiUrl(ep, params) {
  const u = new URL(HOST + ep);
  const base = {
    app_id: APP_ID,
    web: '1',
    channel: 'dubox',
    clienttype: '0',
    ...params,
  };
  for (const [k, v] of Object.entries(base)) u.searchParams.set(k, v);
  return u;
}

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Cookie: cookieToHeader(),
          Referer: `${HOST}/sharing/link?surl=${url.searchParams.get('shorturl') || ''}`,
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

// The API throttles/blacklists an IP for a while if you hammer it, so back off on errno:2.
async function getJson(url, expectErrno = 0) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await get(url);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (j.errno === expectErrno) return j;
    if (j.errno === 2 && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    return j;
  }
}

async function listDir(dirPath) {
  const url = apiUrl('/share/list', {
    shorturl: SURL,
    root: '1', // required even for subdirs; dir carries the path
    dir: dirPath,
    page: '1',
    num: '1000',
  });
  const j = await getJson(url);
  if (j.errno !== 0) throw new Error(`share/list errno=${j.errno} ${j.err_msg || ''}`);
  return j.list || [];
}

async function getDlink(fsId) {
  const url = apiUrl('/share/download', {
    shorturl: SURL,
    fs_id: fsId,
    sign: '',
    timestamp: '',
  });
  const j = await getJson(url);
  if (j.errno !== 0) {
    const err = new Error(`share/download errno=${j.errno} ${j.err_msg || j.errmsg || ''}`);
    err.gated = j.errno === 400310 || j.errno === 400141;
    throw err;
  }
  const d = j.dlink || j.download_link || (j.data && j.data.dlink);
  if (!d) throw new Error('no dlink in response');
  return d;
}

async function walk(rootPath, outDir, total, visited = new Set()) {
  // Cycle guard: a share whose folder lists itself as its only child (empty
  // folder, or the API echoing the parent) must not be walked forever.
  if (visited.has(rootPath)) return;
  visited.add(rootPath);

  const entries = await listDir(rootPath);
  for (const e of entries) {
    if (e.isdir === '1') {
      console.log(`[dir]  ${e.path}`);
      await walk(e.path, outDir, total, visited);
      continue;
    }
    total.files++;
    const name = e.server_filename || path.basename(e.path);
    const dest = path.join(outDir, name);
    try {
      const dlink = await getDlink(e.fs_id);
      console.log(`[get]  ${name} (${(e.size / 1048576).toFixed(1)} MB)`);
      await download(dlink, dest);
      console.log(`  -> ${dest}`);
    } catch (err) {
      if (err.gated) {
        console.error(`[skip] ${name}: download gated (${err.message}). Share is verify-protected — open it in a browser once and it may unlock.`);
        continue;
      }
      console.error(`[fail] ${name}: ${err.message}`);
    }
  }
}

function download(dlink, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(dlink, { headers: { 'User-Agent': UA, Referer: `${HOST}/` } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`dlink HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      pipeline(res, out, (err) => (err ? reject(err) : resolve()));
    });
    req.on('error', reject);
  });
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

let SURL = '';
(async () => {
  const args = process.argv.slice(2);
  const urlArg = args.find((a) => a.startsWith('http'));
  const outArgIdx = args.indexOf('--out');
  const outDir = outArgIdx >= 0 && args[outArgIdx + 1] ? path.resolve(args[outArgIdx + 1]) : process.cwd();
  if (!urlArg) fail('usage: node tera.js <terabox-url> [--out <dir>]');

  let surl;
  try {
    const u = new URL(urlArg);
    const s = u.searchParams.get('surl') || /s\/1([A-Za-z0-9_-]+)/.exec(u.pathname)?.[1];
    if (!s) fail(`cannot extract surl from "${urlArg}"`);
    surl = s;
  } catch {
    fail(`invalid URL: "${urlArg}"`);
  }
  SURL = surl;

  // Visit the share page so the API trusts this session, then resolve a working host.
  await primeCookies(urlArg);
  let probe;
  for (const h of HOSTS) {
    HOST = h;
    try {
      probe = await listDir('/');
      if (probe.length) break;
    } catch {
      /* try next host */
    }
  }
  if (!probe) fail(`share lookup failed: link expired, wrong, or region-blocked (surl=${surl}).`);
  const title = probe[0]?.path?.split('/').filter(Boolean).pop() || 'terabox';
  console.log(`share: "${title}" — ${probe.length} top-level entr${probe.length === 1 ? 'y' : 'ies'}`);

  fs.mkdirSync(outDir, { recursive: true });
  const total = { files: 0 };
  await walk('/', outDir, total);
  console.log(`\ndone: ${total.files} file(s) saved to ${outDir}`);
})().catch((e) => fail(`fatal: ${e.message}`));
