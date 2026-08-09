// ========== 第一部分：后端核心 ==========

const memoryStore = new Map();
const EXCLUDED_TYPES = ['direct', 'selector', 'urltest', 'dns', 'block'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    if (url.pathname === '/' && request.method === 'GET') {
      // 注意：这里引用了第二部分定义的 getHTML 函数
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (url.pathname === '/api/fetch' && request.method === 'POST') {
      return handleFetchProxies(request);
    }
    if (url.pathname === '/api/update' && request.method === 'POST') {
      return handleUpdate(request, env);
    }
    if (url.pathname === '/api/latest' && request.method === 'GET') {
      return handleGetLatest(env);
    }
    return new Response('Not Found', { status: 404 });
  },
};

async function handleFetchProxies(request) {
  try {
    const { sources } = await request.json();
    if (!Array.isArray(sources) || sources.length === 0)
      throw new Error('至少需要一个订阅源');

    const tasks = sources.map(async (src) => {
      const { name, url, type = 'selector' } = src;
      try {
        const resp = await fetch(url, { headers: { 'User-Agent': 'SubMerger/2.3' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        let text = await resp.text();

        let outbounds = tryJSON(text);
        if (!outbounds.length) outbounds = tryYAML(text);
        if (!outbounds.length) outbounds = tryBase64URIList(text);
        if (!outbounds.length) outbounds = tryPlainURIList(text);

        if (!outbounds.length) {
          const preview = text.substring(0, 200).replace(/\n/g, '\\n');
          throw new Error(`无法识别格式或无有效节点（前200字符: ${preview}）`);
        }

        const filtered = outbounds.filter(ob => ob && typeof ob === 'object' && !EXCLUDED_TYPES.includes(ob.type));
        const proxies = filtered.map(ob => ({ ...ob, tag: ob.tag || 'unnamed' }));

        if (!proxies.length) return { name, url, proxies: [], group: null, error: '该源无有效代理节点' };

        const tags = proxies.map(p => p.tag);
        const group = { type, tag: name, outbounds: tags };
        if (type === 'selector') group.default = tags[0] || '';

        return { name, url, proxies, group, error: null };
      } catch (e) {
        return { name, url, proxies: [], group: null, error: e.message };
      }
    });

    const results = await Promise.all(tasks);

    // 全局去重
    const usedTags = new Set();
    results.forEach(res => {
      if (res.error || !res.proxies) return;
      res.proxies = res.proxies.map(proxy => {
        let tag = proxy.tag;
        if (usedTags.has(tag)) {
          let suffix = ` (${res.name})`;
          let newTag = tag + suffix;
          let count = 1;
          while (usedTags.has(newTag)) {
            count++;
            newTag = `${tag} (${res.name} ${count})`;
          }
          tag = newTag;
        }
        usedTags.add(tag);
        return { ...proxy, tag };
      });
      if (res.group) {
        res.group.outbounds = res.proxies.map(p => p.tag);
        if (res.group.type === 'selector' && res.group.outbounds.length > 0) {
          res.group.default = res.group.outbounds[0];
        }
      }
    });

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// ----- 格式解析函数 -----
function tryJSON(text) {
  try { const d = JSON.parse(text); if (Array.isArray(d)) return d; if (d.outbounds) return d.outbounds; } catch (_) {}
  try { const d = JSON.parse(atob(text.trim())); if (Array.isArray(d)) return d; if (d.outbounds) return d.outbounds; } catch (_) {}
  return [];
}

function tryYAML(text) {
  let doc = parseYAML(text);
  let proxies = extractProxies(doc);
  if (proxies.length) return convertClashToSingBox(proxies);
  try { doc = parseYAML(atob(text.trim())); proxies = extractProxies(doc); if (proxies.length) return convertClashToSingBox(proxies); } catch (_) {}
  return [];
}

function extractProxies(obj) {
  if (Array.isArray(obj)) return obj;
  if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === 'proxies') return obj[key];
    }
  }
  return [];
}

function tryBase64URIList(text) {
  try { return tryPlainURIList(atob(text.trim())); } catch (_) { return []; }
}

function tryPlainURIList(text) {
  const lines = text.split(/\r?\n/);
  const uris = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return uris.map(uri => parseProxyURI(uri)).filter(Boolean);
}

function parseProxyURI(uri) {
  try {
    const schemeEnd = uri.indexOf('://');
    if (schemeEnd === -1) return null;
    const scheme = uri.substring(0, schemeEnd).toLowerCase();
    const rest = uri.substring(schemeEnd + 3);
    let name = '';
    const hashIdx = rest.indexOf('#');
    if (hashIdx !== -1) { name = decodeURIComponent(rest.substring(hashIdx + 1)); rest = rest.substring(0, hashIdx); }
    const atIdx = rest.lastIndexOf('@');
    let userinfo = '', hostport = rest;
    if (atIdx !== -1) { userinfo = rest.substring(0, atIdx); hostport = rest.substring(atIdx + 1); }
    const qsIdx = hostport.indexOf('?');
    let params = {};
    if (qsIdx !== -1) { params = Object.fromEntries(new URLSearchParams(hostport.substring(qsIdx + 1)).entries()); hostport = hostport.substring(0, qsIdx); }
    const [host, portStr] = hostport.split(':');
    const port = parseInt(portStr) || 0;
    const tag = name || `${host}:${port}`;
    switch (scheme) {
      case 'ss': {
        let method, password;
        if (userinfo) {
          try { const d = atob(userinfo); const idx = d.indexOf(':'); if (idx !== -1) { method = d.substring(0, idx); password = d.substring(idx + 1); } } catch (_) {}
        }
        return { type: 'shadowsocks', tag, server: host, server_port: port, method: method || 'aes-256-gcm', password: password || '' };
      }
      case 'vmess': {
        try {
          const json = JSON.parse(atob(userinfo));
          const vm = { type: 'vmess', tag: json.ps || tag, server: json.add, server_port: parseInt(json.port) || 0, uuid: json.id, security: json.scy || 'auto', alter_id: parseInt(json.aid) || 0 };
          if (json.tls) vm.tls = { enabled: true, server_name: json.sni || host };
          return vm;
        } catch (_) {}
        return null;
      }
      case 'vless': {
        const v = { type: 'vless', tag, server: host, server_port: port, uuid: userinfo, flow: params.flow || '' };
        if (params.security === 'tls') v.tls = { enabled: true, server_name: params.sni || host };
        if (params.type) v.transport = { type: params.type, ...(params.type === 'ws' ? { path: params.path } : {}) };
        return v;
      }
      case 'trojan': {
        const t = { type: 'trojan', tag, server: host, server_port: port, password: userinfo };
        if (params.security === 'tls' || params.sni) t.tls = { enabled: true, server_name: params.sni || host };
        return t;
      }
      case 'http': case 'https': {
        const [u, p] = userinfo.split(':');
        return { type: 'http', tag, server: host, server_port: port, username: u || '', password: p || '' };
      }
      case 'socks': case 'socks5': {
        const [u, p] = userinfo.split(':');
        return { type: 'socks', tag, server: host, server_port: port, username: u || '', password: p || '' };
      }
      default: return null;
    }
  } catch (_) { return null; }
}

// ----- YAML 解析器（支持行内映射） -----
function parseYAML(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  function skip() { while (i < lines.length && lines[i].replace(/#.*$/, '').trim() === '') i++; }
  function parseValue(indent) {
    skip();
    if (i >= lines.length) return null;
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trimEnd();
    const curIndent = raw.search(/\S/);
    if (curIndent < indent) return null;
    const content = line.trim();

    if (content.startsWith('- ')) {
      const list = [];
      while (i < lines.length) {
        skip();
        if (i >= lines.length) break;
        const raw2 = lines[i];
        const line2 = raw2.replace(/#.*$/, '').trimEnd();
        const ind2 = raw2.search(/\S/);
        const con2 = line2.trim();
        if (!con2.startsWith('- ') || ind2 < indent) break;
        i++;
        const rest = con2.substring(2).trim();
        if (rest.startsWith('{') && rest.endsWith('}')) {
          list.push(parseFlowMapping(rest));
        } else if (rest.includes(':')) {
          const ci = rest.indexOf(':');
          const key = rest.substring(0, ci).trim();
          const after = rest.substring(ci + 1).trim();
          if (after === '') {
            i--;
            list.push(parseMapping(ind2 + 2));
          } else {
            list.push({ [key]: parseScalar(after) });
          }
        } else {
          list.push(parseScalar(rest));
        }
      }
      return list;
    }

    if (content.includes(':')) {
      return parseMapping(indent);
    }

    return parseScalar(content);
  }

  function parseMapping(baseIndent) {
    const map = {};
    while (i < lines.length) {
      skip();
      if (i >= lines.length) break;
      const raw = lines[i];
      const line = raw.replace(/#.*$/, '').trimEnd();
      const indent = raw.search(/\S/);
      if (indent < baseIndent) break;
      const content = line.trim();
      if (content.startsWith('- ')) break;
      const ci = content.indexOf(':');
      if (ci === -1) { i++; continue; }
      const key = content.substring(0, ci).trim();
      const after = content.substring(ci + 1).trim();
      if (after === '') {
        i++;
        map[key] = parseValue(indent + 2);
      } else {
        i++;
        map[key] = parseScalar(after);
      }
    }
    return map;
  }

  function parseScalar(str) {
    str = str.trim();
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) str = str.slice(1, -1);
    if (str === 'true') return true;
    if (str === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(str)) return Number(str);
    return str;
  }

  function parseFlowMapping(str) {
    str = str.slice(1, -1).trim();
    const obj = {};
    if (!str) return obj;
    const pairs = str.split(/,(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/);
    pairs.forEach(p => {
      const ci = p.indexOf(':');
      if (ci === -1) return;
      const key = p.substring(0, ci).trim();
      let value = p.substring(ci + 1).trim();
      obj[key] = parseScalar(value);
    });
    return obj;
  }

  skip();
  if (i < lines.length && lines[i].replace(/#.*$/, '').trim().startsWith('- ')) {
    const arr = [];
    while (i < lines.length) {
      skip();
      if (i >= lines.length) break;
      const raw = lines[i];
      const con = raw.replace(/#.*$/, '').trim();
      if (!con.startsWith('- ')) break;
      i++;
      const rest = con.substring(2).trim();
      if (rest.startsWith('{') && rest.endsWith('}')) {
        arr.push(parseFlowMapping(rest));
      } else if (rest.includes(':')) {
        const ci = rest.indexOf(':');
        const key = rest.substring(0, ci).trim();
        const after = rest.substring(ci + 1).trim();
        if (after === '') {
          arr.push(parseMapping(raw.search(/\S/) + 2));
        } else {
          arr.push({ [key]: parseScalar(after) });
        }
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }
  return parseMapping(0);
}

// ----- Clash 代理 → Sing‑Box 出站 -----
function convertClashToSingBox(proxies) {
  if (!Array.isArray(proxies)) return [];
  return proxies.map(p => {
    if (!p || typeof p !== 'object') return null;
    const base = { tag: p.name || p.server || 'unknown' };
    function getTLS() {
      if (p.tls || p.sni || p.servername) {
        const tls = { enabled: true };
        if (p.sni || p.servername) tls.server_name = p.sni || p.servername;
        if (p['skip-cert-verify'] != null) tls.insecure = !!p['skip-cert-verify'];
        return tls;
      }
      return undefined;
    }
    switch (p.type) {
      case 'ss':
        return { ...base, type: 'shadowsocks', server: p.server, server_port: parseInt(p.port) || 0, method: p.cipher || 'aes-256-gcm', password: p.password };
      case 'vmess': {
        const vm = { ...base, type: 'vmess', server: p.server, server_port: parseInt(p.port) || 0, uuid: p.uuid, security: p.cipher || 'auto', alter_id: parseInt(p.alterId) || 0 };
        const tls = getTLS();
        if (tls) vm.tls = tls;
        return vm;
      }
      case 'trojan': {
        const t = { ...base, type: 'trojan', server: p.server, server_port: parseInt(p.port) || 0, password: p.password };
        const tls = getTLS();
        if (tls) t.tls = tls;
        return t;
      }
      case 'vless': {
        const v = { ...base, type: 'vless', server: p.server, server_port: parseInt(p.port) || 443, uuid: p.uuid };
        if (p.flow) v.flow = p.flow;
        const tls = getTLS();
        if (tls) v.tls = tls;
        if (p.network) {
          v.transport = { type: p.network };
          if (p.network === 'ws' && p['ws-opts']) {
            const ws = p['ws-opts'];
            if (ws.path) v.transport.path = ws.path;
            if (ws.headers && ws.headers.Host) v.transport.headers = { Host: ws.headers.Host };
          } else if (p.network === 'grpc' && p['grpc-opts']) {
            const grpc = p['grpc-opts'];
            if (grpc.serviceName) v.transport.service_name = grpc.serviceName;
          }
        }
        return v;
      }
      case 'anytls': {
        const a = { ...base, type: 'anytls', server: p.server, server_port: parseInt(p.port) || 443, password: p.password, tls: {} };
        const tls = getTLS();
        if (tls) a.tls = tls;
        if (Object.keys(a.tls).length === 0) delete a.tls;
        return a;
      }
      case 'http':
        return { ...base, type: 'http', server: p.server, server_port: parseInt(p.port) || 0, username: p.username || '', password: p.password || '' };
      case 'socks5':
        return { ...base, type: 'socks', server: p.server, server_port: parseInt(p.port) || 0, username: p.username || '', password: p.password || '' };
      default: return null;
    }
  }).filter(Boolean);
}

// ----- 永久链接处理 -----
async function handleUpdate(request, env) {
  const configStr = JSON.stringify(await request.json());
  if (env.SUB_CONFIG) await env.SUB_CONFIG.put('latest', configStr);
  else memoryStore.set('latest', configStr);
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function handleGetLatest(env) {
  const config = env.SUB_CONFIG ? await env.SUB_CONFIG.get('latest', 'text') : memoryStore.get('latest');
  if (config) return new Response(config, {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
  });
  return new Response('尚未生成任何配置', { status: 404 });
}
// ========== 第二部分：前端 HTML ==========
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sing‑Box / Clash 订阅合并器</title>
  <style>
    * { box-sizing: border-box; } body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 1rem; background: #f2f2f7; color: #1c1c1e; line-height: 1.5; }
    h1 { margin-top: 0; font-weight: 600; font-size: 1.8rem; color: #000; }
    h2 { font-weight: 500; font-size: 1.2rem; margin: 1.5rem 0 0.5rem; color: #3a3a3c; }
    p { margin: 0.5rem 0; font-size: 0.95rem; }
    .card { background: #fff; border-radius: 12px; padding: 1.2rem; margin-bottom: 1.5rem; box-shadow: 0 4px 12px rgba(0,0,0,0.05); border: 1px solid #e5e5ea; width: 100%; }
    .source-row { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-bottom: 0.6rem; align-items: center; }
    .source-row input, .source-row select { padding: 0.5rem 0.7rem; border: 1px solid #d1d1d6; border-radius: 8px; font-size: 0.9rem; background: #fff; min-width: 0; }
    .source-row input:focus, .source-row select:focus { outline: none; border-color: #007aff; box-shadow: 0 0 0 3px rgba(0,122,255,0.15); }
    .name { flex: 1 1 100px; }
    .url { flex: 3 1 200px; }
    .type { flex: 0 1 110px; }
    .remove-btn-wrapper { flex: 0 0 auto; }
    .cache-status { font-size: 0.75rem; color: #6e6e73; margin-left: 0.5rem; white-space: nowrap; }
    button { padding: 0.5rem 1rem; cursor: pointer; border: none; border-radius: 8px; font-weight: 500; font-size: 0.9rem; color: #fff; white-space: nowrap; transition: background 0.2s; }
    .remove-btn { background: #ff3b30; padding: 0.5rem; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; }
    .remove-btn:hover { background: #e0352b; }
    .add-btn { background: #007aff; margin-top: 0.5rem; }
    .add-btn:hover { background: #0066d6; }
    .action-btn { background: #34c759; margin-right: 0.5rem; }
    .action-btn:hover { background: #2db14e; }
    .action-btn:disabled { background: #aeaeb2; cursor: not-allowed; }
    .copy-btn { background: #5e5ce6; }
    .copy-btn:hover { background: #4b49cc; }
    .import-btn { background: #5856d6; margin-left: 0.5rem; }
    .import-btn:hover { background: #4b49cc; }
    .refresh-btn { background: #ff9f0a; margin-right: 0.5rem; }
    .refresh-btn:hover { background: #e68600; }
    .code-editor { width: 100%; max-width: 100%; min-height: 150px; font-family: 'SF Mono', Menlo, monospace; font-size: 0.85rem; line-height: 1.6; padding: 1rem; border: 1px solid #48484a; border-radius: 8px; background: #1e1e1e; color: #d4d4d4; resize: vertical; tab-size: 2; outline: none; box-sizing: border-box; }
    .code-editor:focus { border-color: #007aff; box-shadow: 0 0 0 3px rgba(0,122,255,0.3); }
    .output-area { width: 100%; height: 400px; font-family: 'SF Mono', Menlo, monospace; font-size: 0.85rem; padding: 1rem; border: 1px solid #48484a; border-radius: 8px; background: #1e1e1e; color: #d4d4d4; resize: vertical; white-space: pre; overflow: auto; box-sizing: border-box; }
    #status { margin: 0.8rem 0; min-height: 1.5rem; font-size: 0.9rem; }
    .error { color: #ff3b30; }
    .warning { color: #ff9f0a; }
    .success { color: #34c759; }
    .info { color: #5e5ce6; }
    .flex-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.8rem; }
    .subscription-link-box { background: #1e1e1e; color: #d4d4d4; padding: 0.6rem 1rem; border-radius: 8px; font-family: monospace; word-break: break-all; margin: 0.5rem 0; font-size: 0.9rem; display: flex; align-items: center; gap: 0.5rem; }
    .subscription-link-box span { flex: 1; }
    .subscription-link-box button { background: #34c759; font-size: 0.8rem; }
    @media (max-width: 600px) {
      body { padding: 0.8rem; margin: 1rem auto; }
      .name { flex: 1 1 80px; }
      .url { flex: 3 1 150px; }
      .type { flex: 0 1 100px; }
    }
  </style>
</head>
<body>
  <h1>🔀 Sing‑Box / Clash 订阅合并器</h1>
  <p style="color: #6e6e73;">支持 JSON、YAML（含行内映射）以及 Base64 URI 列表，自动转换为 Sing‑Box 配置。</p>

  <div class="card">
    <h2>🔗 永久订阅链接</h2>
    <p style="color: #6e6e73; font-size: 0.85rem;">每次生成后自动更新。可导入 Sing‑Box 客户端。</p>
    <div id="subscription-link-container">
      <div class="subscription-link-box" id="subscription-link-box" style="display:none;">
        <span id="subscription-link-text"></span>
        <button id="copy-permanent-link">📋 复制</button>
      </div>
      <p id="no-link-hint" style="color: #6e6e73;">尚未生成配置</p>
    </div>
    <p style="font-size:0.8rem; color:#8e8e93;">建议绑定 KV (变量名 <code>SUB_CONFIG</code>) 实现永久存储。</p>
  </div>

  <div class="card">
    <h2>📥 订阅源设置</h2>
    <div id="sources-container"></div>
    <button id="add-source" class="add-btn">＋ 添加订阅源</button>
  </div>

  <div class="card">
    <h2>📦 其他配置 (JSON)</h2>
    <p style="color: #6e6e73; font-size:0.85rem;">例如 log, inbounds, route 等，<strong>可以包含 outbounds</strong>，拉取的节点将追加其后。<br>
    <button class="import-btn" id="import-file-btn" style="font-size:0.8rem; padding:0.2rem 0.6rem;">📂 从文件导入</button></p>
    <textarea id="config-input" class="code-editor" placeholder='{"log":{"level":"info"},"inbounds":[...]}'></textarea>
  </div>

  <div class="flex-row">
    <button id="generate" class="action-btn">⚡ 生成配置（优先缓存）</button>
    <button id="refresh-generate" class="refresh-btn">🔄 强制刷新并生成</button>
    <button id="download" class="action-btn" style="display:none;">⬇ 下载 JSON</button>
    <button id="copy-result" class="copy-btn" style="display:none;">📋 复制 JSON</button>
  </div>

  <div id="status"></div>
  <div id="result" style="display:none;" class="card">
    <h2>✅ 生成的配置</h2>
    <textarea id="output" class="output-area" readonly></textarea>
  </div>

  <script>
    (function() {
      // ========== IndexedDB 封装 ==========
      const DB_NAME = 'sub-merger';
      const DB_VERSION = 3;
      const CONFIG_STORE = 'config';
      const CACHE_STORE = 'cache';
      const META_STORE = 'meta';
      const PERMALINK_KEY = 'permalink';
      const SOURCES_KEY = 'sources';

      let db = null;
      function openDB() {
        return new Promise((resolve, reject) => {
          if (db) return resolve(db);
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains(CONFIG_STORE)) d.createObjectStore(CONFIG_STORE, { keyPath: 'id' });
            if (!d.objectStoreNames.contains(CACHE_STORE)) d.createObjectStore(CACHE_STORE, { keyPath: 'url' });
            if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE, { keyPath: 'id' });
          };
          req.onsuccess = (e) => { db = e.target.result; resolve(db); };
          req.onerror = (e) => reject(e.target.error);
        });
      }

      async function saveConfigToDB(text) {
        try {
          const d = await openDB();
          const tx = d.transaction(CONFIG_STORE, 'readwrite');
          tx.objectStore(CONFIG_STORE).put({ id: 'other_config', value: text });
          return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        } catch(e) {}
      }

      async function loadConfigFromDB() {
        try {
          const d = await openDB();
          const tx = d.transaction(CONFIG_STORE, 'readonly');
          const req = tx.objectStore(CONFIG_STORE).get('other_config');
          return new Promise((res, rej) => {
            req.onsuccess = () => res(req.result ? req.result.value : '');
            req.onerror = rej;
          });
        } catch(e) { return ''; }
      }

      async function saveProxyCache(url, proxies, group) {
        try {
          const d = await openDB();
          const tx = d.transaction(CACHE_STORE, 'readwrite');
          tx.objectStore(CACHE_STORE).put({ url, proxies, group, timestamp: Date.now() });
          return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        } catch(e) {}
      }

      async function getProxyCache(url) {
        try {
          const d = await openDB();
          const tx = d.transaction(CACHE_STORE, 'readonly');
          const req = tx.objectStore(CACHE_STORE).get(url);
          return new Promise((res, rej) => {
            req.onsuccess = () => res(req.result || null);
            req.onerror = rej;
          });
        } catch(e) { return null; }
      }

      async function savePermalink(link) {
        try {
          const d = await openDB();
          const tx = d.transaction(META_STORE, 'readwrite');
          tx.objectStore(META_STORE).put({ id: PERMALINK_KEY, value: link });
          return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        } catch(e) {}
      }

      async function loadPermalink() {
        try {
          const d = await openDB();
          const tx = d.transaction(META_STORE, 'readonly');
          const req = tx.objectStore(META_STORE).get(PERMALINK_KEY);
          return new Promise((res, rej) => {
            req.onsuccess = () => res(req.result ? req.result.value : '');
            req.onerror = rej;
          });
        } catch(e) { return ''; }
      }

      // ========== 订阅源列表 localStorage ==========
      function loadSources() {
        try {
          const s = localStorage.getItem(SOURCES_KEY);
          if (s) {
            const arr = JSON.parse(s);
            if (Array.isArray(arr) && arr.length > 0) return arr;
          }
        } catch(e) {}
        return [{ name: 'HK', url: 'https://example.com/sub', type: 'selector' }];
      }

      function saveSources(arr) {
        localStorage.setItem(SOURCES_KEY, JSON.stringify(arr));
      }

      // ========== UI 元素 ==========
      const sourcesContainer = document.getElementById('sources-container');
      const addBtn = document.getElementById('add-source');
      const generateBtn = document.getElementById('generate');
      const refreshBtn = document.getElementById('refresh-generate');
      const downloadBtn = document.getElementById('download');
      const copyResultBtn = document.getElementById('copy-result');
      const configInput = document.getElementById('config-input');
      const outputArea = document.getElementById('output');
      const resultDiv = document.getElementById('result');
      const statusDiv = document.getElementById('status');
      const importFileBtn = document.getElementById('import-file-btn');
      const subLinkBox = document.getElementById('subscription-link-box');
      const subLinkText = document.getElementById('subscription-link-text');
      const copyPermaBtn = document.getElementById('copy-permanent-link');
      const noLinkHint = document.getElementById('no-link-hint');
      const permalinkBase = location.origin + '/api/latest';

      // ========== 辅助函数 ==========
      function collectSources() {
        const rows = document.querySelectorAll('.source-row');
        const res = [];
        rows.forEach(row => {
          const name = row.querySelector('.name').value.trim();
          const url = row.querySelector('.url').value.trim();
          const type = row.querySelector('.type').value;
          if (name || url) res.push({ name, url, type });
        });
        return res;
      }

      let saveTimer;
      function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveSources(collectSources());
          saveConfigToDB(configInput.value);
        }, 300);
      }

      function updatePermalinkDisplay() {
        subLinkText.textContent = permalinkBase;
        subLinkBox.style.display = 'flex';
        noLinkHint.style.display = 'none';
      }

      async function updateCacheIndicators() {
        const rows = document.querySelectorAll('.source-row');
        for (const row of rows) {
          const urlInput = row.querySelector('.url');
          if (!urlInput) continue;
          const url = urlInput.value.trim();
          if (!url) continue;
          const cache = await getProxyCache(url);
          let span = row.querySelector('.cache-status');
          if (!span) {
            span = document.createElement('span');
            span.className = 'cache-status';
            row.appendChild(span);
          }
          if (cache) {
            const d = new Date(cache.timestamp);
            span.textContent = '缓存: ' + cache.proxies.length + ' 节点 (' + d.toLocaleString() + ')';
          } else {
            span.textContent = '无缓存';
          }
        }
      }

      function createSourceRow(name='', url='', type='selector') {
        const div = document.createElement('div');
        div.className = 'source-row';
        div.innerHTML = \`<input class="name" placeholder="组名" value="\${name}"><input class="url" placeholder="订阅源 URL" value="\${url}"><select class="type"><option value="selector" \${type==='selector'?'selected':''}>selector</option><option value="urltest" \${type==='urltest'?'selected':''}>urltest</option></select><span class="remove-btn-wrapper"><button class="remove-btn">✕</button></span>\`;
        div.querySelector('.remove-btn').addEventListener('click', () => {
          div.remove();
          scheduleSave();
          updateCacheIndicators();
        });
        div.querySelectorAll('input, select').forEach(el => {
          el.addEventListener('input', scheduleSave);
          el.addEventListener('change', scheduleSave);
        });
        return div;
      }

      function renderSources(sources) {
        sourcesContainer.innerHTML = '';
        sources.forEach(s => sourcesContainer.appendChild(createSourceRow(s.name, s.url, s.type)));
        updateCacheIndicators();
      }

      function parseJSONSafe(text) {
        const fixed = text.replace(/,(\\s*[}\\]])/g, '$1');
        try { return JSON.parse(fixed); }
        catch(e) { throw new Error('JSON 格式错误：' + e.message); }
      }

      // ========== 与后端通信 ==========
      async function fetchProxiesFromBackend(sources) {
        const resp = await fetch('/api/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources })
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || '请求失败');
        }
        const data = await resp.json();
        return data.results;
      }

      // ========== 核心生成逻辑 ==========
      async function performGenerate(force) {
        statusDiv.innerHTML = '';
        resultDiv.style.display = 'none';
        downloadBtn.style.display = 'none';
        copyResultBtn.style.display = 'none';

        const rows = document.querySelectorAll('.source-row');
        const sources = [];
        for (const row of rows) {
          const name = row.querySelector('.name').value.trim();
          const url = row.querySelector('.url').value.trim();
          const type = row.querySelector('.type').value;
          if (!name || !url) {
            statusDiv.innerHTML = '<span class="error">请填写所有组名和 URL</span>';
            return;
          }
          sources.push({ name, url, type });
        }

        let configObj = {};
        const configText = configInput.value.trim();
        if (configText) {
          try { configObj = parseJSONSafe(configText); }
          catch(e) {
            statusDiv.innerHTML = '<span class="error">' + e.message + '</span>';
            return;
          }
        }

        saveSources(sources);
        saveConfigToDB(configText);
        statusDiv.textContent = '正在拉取订阅源...';

        // 决定哪些源需要远程拉取
        const toFetch = [];
        const fromCache = [];
        for (const src of sources) {
          if (!force) {
            const cache = await getProxyCache(src.url);
            if (cache) {
              fromCache.push({ ...src, proxies: cache.proxies, group: cache.group, fromCache: true, error: null });
              continue;
            }
          }
          toFetch.push(src);
        }

        let fetched = [];
        if (toFetch.length > 0) {
          try {
            fetched = await fetchProxiesFromBackend(toFetch);
          } catch(e) {
            for (const src of toFetch) {
              const cache = await getProxyCache(src.url);
              if (cache) {
                fromCache.push({ ...src, proxies: cache.proxies, group: cache.group, fromCache: true, error: e.message });
              } else {
                fromCache.push({ ...src, proxies: [], group: null, fromCache: false, error: e.message });
              }
            }
            fetched = [];
          }
        }

        // 处理拉取结果，更新缓存
        const all = [...fromCache];
        for (const res of fetched) {
          if (!res.error) {
            await saveProxyCache(res.url, res.proxies, res.group);
            all.push({ ...res, fromCache: false });
          } else {
            const cache = await getProxyCache(res.url);
            if (cache) {
              all.push({ ...res, proxies: cache.proxies, group: cache.group, fromCache: true, error: res.error });
            } else {
              all.push({ ...res, fromCache: false });
            }
          }
        }

        // 合并
        const allProxies = [], allGroups = [], errors = [], cacheInfo = [];
        all.forEach(res => {
          if (res.error) {
            if (res.fromCache) {
              cacheInfo.push('[' + res.name + '] 拉取失败，使用缓存 (' + res.proxies.length + ' 节点)');
              allProxies.push(...res.proxies);
              if (res.group) allGroups.push(res.group);
            } else {
              errors.push('[' + res.name + '] ' + res.error);
            }
          } else {
            if (res.fromCache) {
              cacheInfo.push('[' + res.name + '] 使用缓存 (' + res.proxies.length + ' 节点)');
            }
            allProxies.push(...res.proxies);
            if (res.group) allGroups.push(res.group);
          }
        });

        let statusHTML = '';
        if (errors.length) statusHTML += '<span class="error">⚠ 无缓存且拉取失败：' + errors.join('; ') + '</span><br>';
        if (cacheInfo.length) statusHTML += '<span class="info">ℹ️ ' + cacheInfo.join('; ') + '</span>';
        if (!errors.length && !cacheInfo.length) statusHTML = '<span class="success">✅ 生成成功！</span>';
        else if (!errors.length) statusHTML += '<span class="success">✅ 生成成功（使用缓存）</span>';
        statusDiv.innerHTML = statusHTML;

        const userOutbounds = Array.isArray(configObj.outbounds) ? configObj.outbounds : [];
        const finalOutbounds = [...userOutbounds, ...allProxies, ...allGroups];
        const { outbounds: _, ...rest } = configObj;
        const finalConfig = { ...rest, outbounds: finalOutbounds };

        const jsonStr = JSON.stringify(finalConfig, null, 2);
        outputArea.value = jsonStr;
        resultDiv.style.display = 'block';
        downloadBtn.style.display = 'inline-block';
        copyResultBtn.style.display = 'inline-block';

        // 更新永久订阅
        try {
          await fetch('/api/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: jsonStr,
          });
          await savePermalink(permalinkBase);
          updatePermalinkDisplay();
        } catch(e) {}

        downloadBtn.onclick = () => {
          const blob = new Blob([jsonStr], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'sing-box-config.json';
          a.click();
        };

        copyResultBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(jsonStr);
            copyResultBtn.textContent = '✅ 已复制';
            setTimeout(() => copyResultBtn.textContent = '📋 复制 JSON', 2000);
          } catch(e) {
            copyResultBtn.textContent = '❌ 失败';
            setTimeout(() => copyResultBtn.textContent = '📋 复制 JSON', 2000);
          }
        };

        updateCacheIndicators();
      }

      // ========== 事件绑定 ==========
      generateBtn.addEventListener('click', () => performGenerate(false));
      refreshBtn.addEventListener('click', () => performGenerate(true));

      addBtn.addEventListener('click', () => {
        sourcesContainer.appendChild(createSourceRow());
        scheduleSave();
        updateCacheIndicators();
      });

      configInput.addEventListener('input', scheduleSave);

      importFileBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.txt';
        input.onchange = e => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = ev => { configInput.value = ev.target.result; scheduleSave(); };
          reader.readAsText(file);
        };
        input.click();
      });

      copyPermaBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(subLinkText.textContent);
          copyPermaBtn.textContent = '✅ 已复制';
          setTimeout(() => copyPermaBtn.textContent = '📋 复制', 2000);
        } catch(e) {
          copyPermaBtn.textContent = '❌ 失败';
          setTimeout(() => copyPermaBtn.textContent = '📋 复制', 2000);
        }
      });

      // 初始化
      (async function init() {
        const sources = loadSources();
        renderSources(sources);
        const savedConfig = await loadConfigFromDB();
        if (savedConfig) configInput.value = savedConfig;
        const savedLink = await loadPermalink();
        if (savedLink) {
          subLinkText.textContent = savedLink;
          subLinkBox.style.display = 'flex';
          noLinkHint.style.display = 'none';
        }
      })();
    })();
  </script>
</body>
</html>`;
}
