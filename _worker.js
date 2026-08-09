// _workers.js - Sing‑Box & Clash 订阅合并器（支持行内映射、TLS、多格式）
// 建议绑定 KV 至 SUB_CONFIG

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

/* ==================================================
   后端拉取与解析（支持 JSON/YAML/Base64 URI 列表）
   ================================================== */
async function handleFetchProxies(request) {
  try {
    const { sources } = await request.json();
    if (!Array.isArray(sources) || sources.length === 0)
      throw new Error('至少需要一个订阅源');

    const tasks = sources.map(async (src) => {
      const { name, url, type = 'selector' } = src;
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'SubMerger/2.3' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        let text = await resp.text();

        // 1. JSON
        let outbounds = tryJSON(text);
        // 2. YAML
        if (outbounds.length === 0) outbounds = tryYAML(text);
        // 3. Base64 URI 列表
        if (outbounds.length === 0) outbounds = tryBase64URIList(text);
        // 4. 纯文本 URI 列表
        if (outbounds.length === 0) outbounds = tryPlainURIList(text);

        if (outbounds.length === 0) {
          const preview = text.substring(0, 200).replace(/\n/g, '\\n');
          throw new Error(`无法识别格式或无有效节点（前200字符: ${preview}）`);
        }

        const filtered = outbounds.filter(
          (ob) => ob && typeof ob === 'object' && !EXCLUDED_TYPES.includes(ob.type)
        );
        const proxies = filtered.map((ob) => ({
          ...ob,
          tag: ob.tag || 'unnamed',
        }));

        if (!proxies.length)
          return { name, url, proxies: [], group: null, error: '该源无有效代理节点' };

        const tags = proxies.map((p) => p.tag);
        const group = { type, tag: name, outbounds: tags };
        if (type === 'selector') group.default = tags[0] || '';

        return { name, url, proxies, group, error: null };
      } catch (e) {
        return { name, url, proxies: [], group: null, error: e.message };
      }
    });

    const results = await Promise.all(tasks);

    // 全局 tag 去重
    const usedTags = new Set();
    results.forEach((res) => {
      if (res.error || !res.proxies) return;
      res.proxies = res.proxies.map((proxy) => {
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
        res.group.outbounds = res.proxies.map((p) => p.tag);
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
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/* ========== JSON / YAML / URI 解析函数 ========== */
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
          return { type: 'vmess', tag: json.ps || tag, server: json.add, server_port: parseInt(json.port) || 0, uuid: json.id, security: json.scy || 'auto', alter_id: parseInt(json.aid) || 0, ...(json.tls && { tls: { enabled: true, server_name: json.sni || host } }) };
        } catch (_) {}
        return null;
      }
      case 'vless': {
        return { type: 'vless', tag, server: host, server_port: port, uuid: userinfo, flow: params.flow || '', tls: params.security === 'tls' ? { enabled: true, server_name: params.sni || host } : undefined, transport: params.type ? { type: params.type, ...(params.type === 'ws' ? { path: params.path } : {}) } : undefined };
      }
      case 'trojan': {
        const out = { type: 'trojan', tag, server: host, server_port: port, password: userinfo };
        if (params.security === 'tls' || params.sni) out.tls = { enabled: true, server_name: params.sni || host };
        return out;
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

/* ==================================================
   增强 YAML 解析器（支持行内映射/列表）
   ================================================== */
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

    // 列表项
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
          // 行内映射
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

    // 映射项
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
    // 解析 {key: value, key: value}
    str = str.slice(1, -1).trim();
    const obj = {};
    if (!str) return obj;
    // 简单分割，考虑值中可能含逗号但无嵌套
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

/* ==================================================
   Clash → Sing‑Box（支持 TLS、skip-cert-verify）
   ================================================== */
function convertClashToSingBox(proxies) {
  if (!Array.isArray(proxies)) return [];
  return proxies.map(p => {
    if (!p || typeof p !== 'object') return null;
    const base = { tag: p.name || p.server || 'unknown' };
    // 通用 TLS 处理
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

/* ========== 永久链接 ========== */
async function handleUpdate(request, env) {
  const configStr = JSON.stringify(await request.json());
  if (env.SUB_CONFIG) await env.SUB_CONFIG.put('latest', configStr);
  else memoryStore.set('latest', configStr);
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

async function handleGetLatest(env) {
  const config = env.SUB_CONFIG ? await env.SUB_CONFIG.get('latest', 'text') : memoryStore.get('latest');
  if (config) return new Response(config, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } });
  return new Response('尚未生成任何配置', { status: 404 });
}

/* ========== 前端 HTML ========== */
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sing‑Box / Clash 订阅合并器</title>
  <style>
    * { box-sizing: border-box; } body { font-family: -apple-system, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 1rem; background: #f2f2f7; color: #1c1c1e; }
    .card { background: #fff; border-radius: 12px; padding: 1.2rem; margin-bottom: 1.5rem; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .source-row { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-bottom: 0.6rem; align-items: center; }
    input, select { padding: 0.5rem; border: 1px solid #d1d1d6; border-radius: 8px; min-width: 0; }
    .name { flex: 1 1 100px; } .url { flex: 3 1 200px; } .type { flex: 0 1 110px; }
    button { padding: 0.5rem 1rem; border: none; border-radius: 8px; cursor: pointer; color: #fff; font-weight: 500; }
    .remove-btn { background: #ff3b30; } .add-btn { background: #007aff; } .action-btn { background: #34c759; margin-right: 0.5rem; } .refresh-btn { background: #ff9f0a; margin-right: 0.5rem; } .copy-btn { background: #5e5ce6; }
    .code-editor { width: 100%; min-height: 150px; font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 8px; resize: vertical; }
    .output-area { width: 100%; height: 400px; font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 8px; }
    #status { margin: 0.8rem 0; } .error { color: #ff3b30; } .warning { color: #ff9f0a; } .success { color: #34c759; } .info { color: #5e5ce6; }
    .subscription-link-box { background: #1e1e1e; color: #d4d4d4; padding: 0.6rem; border-radius: 8px; display: flex; align-items: center; gap: 0.5rem; }
  </style>
</head>
<body>
  <h1>🔀 Sing‑Box / Clash 订阅合并器</h1>
  <p>支持 JSON、YAML（含行内映射）以及 Base64 URI 列表，自动转换为 Sing‑Box 配置。</p>

  <div class="card">
    <h2>🔗 永久订阅链接</h2>
    <div id="subscription-link-container">
      <div class="subscription-link-box" id="subscription-link-box" style="display:none;"><span id="subscription-link-text"></span><button id="copy-permanent-link">📋 复制</button></div>
      <p id="no-link-hint">尚未生成配置</p>
    </div>
    <p style="font-size:0.8rem;">建议绑定 KV 至 <code>SUB_CONFIG</code> 实现永久存储。</p>
  </div>

  <div class="card">
    <h2>📥 订阅源</h2>
    <div id="sources-container"></div>
    <button id="add-source" class="add-btn">＋ 添加</button>
  </div>

  <div class="card">
    <h2>📦 其他配置 (JSON)</h2>
    <p><button class="import-btn" id="import-file-btn">📂 从文件导入</button></p>
    <textarea id="config-input" class="code-editor" placeholder='{"log":{"level":"info"},"inbounds":[...]}'></textarea>
  </div>

  <div>
    <button id="generate" class="action-btn">⚡ 生成（缓存）</button>
    <button id="refresh-generate" class="refresh-btn">🔄 强制刷新</button>
    <button id="download" class="action-btn" style="display:none;">⬇ 下载</button>
    <button id="copy-result" class="copy-btn" style="display:none;">📋 复制</button>
  </div>
  <div id="status"></div>
  <div id="result" style="display:none;" class="card">
    <h2>✅ 配置</h2>
    <textarea id="output" class="output-area" readonly></textarea>
  </div>

  <script>
    (function() {
      const DB_NAME='sub-merger', DB_VERSION=3;
      const CONFIG_STORE='config', CACHE_STORE='cache', META_STORE='meta';
      const PERMALINK_KEY='permalink', SOURCES_KEY='sources';
      let db;
      function openDB(){return new Promise((res,rej)=>{if(db)return res(db);const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=e=>{const d=e.target.result;if(!d.objectStoreNames.contains(CONFIG_STORE))d.createObjectStore(CONFIG_STORE,{keyPath:'id'});if(!d.objectStoreNames.contains(CACHE_STORE))d.createObjectStore(CACHE_STORE,{keyPath:'url'});if(!d.objectStoreNames.contains(META_STORE))d.createObjectStore(META_STORE,{keyPath:'id'})};r.onsuccess=e=>{db=e.target.result;res(db)};r.onerror=e=>rej(e.target.error)})}
      async function saveConfigToDB(text){try{const d=await openDB();const tx=d.transaction(CONFIG_STORE,'readwrite');tx.objectStore(CONFIG_STORE).put({id:'cfg',value:text});return new Promise(r=>tx.oncomplete=r)}catch(e){}}
      async function loadConfigFromDB(){try{const d=await openDB();const tx=d.transaction(CONFIG_STORE,'readonly');const r=tx.objectStore(CONFIG_STORE).get('cfg');return new Promise(res=>r.onsuccess=()=>res(r.result?r.result.value:''))}catch(e){return''}}
      async function saveProxyCache(url,proxies,group){try{const d=await openDB();const tx=d.transaction(CACHE_STORE,'readwrite');tx.objectStore(CACHE_STORE).put({url,proxies,group,timestamp:Date.now()});return new Promise(r=>tx.oncomplete=r)}catch(e){}}
      async function getProxyCache(url){try{const d=await openDB();const tx=d.transaction(CACHE_STORE,'readonly');const r=tx.objectStore(CACHE_STORE).get(url);return new Promise(res=>r.onsuccess=()=>res(r.result||null))}catch(e){return null}}
      async function savePermalink(link){try{const d=await openDB();const tx=d.transaction(META_STORE,'readwrite');tx.objectStore(META_STORE).put({id:PERMALINK_KEY,value:link});return new Promise(r=>tx.oncomplete=r)}catch(e){}}
      async function loadPermalink(){try{const d=await openDB();const tx=d.transaction(META_STORE,'readonly');const r=tx.objectStore(META_STORE).get(PERMALINK_KEY);return new Promise(res=>r.onsuccess=()=>res(r.result?r.result.value:''))}catch(e){return''}}
      function loadSources(){try{const s=localStorage.getItem(SOURCES_KEY);return s?JSON.parse(s):[{name:'HK',url:'https://example.com/sub',type:'selector'}]}catch(e){return[{name:'HK',url:'https://example.com/sub',type:'selector'}]}}
      function saveSources(arr){localStorage.setItem(SOURCES_KEY,JSON.stringify(arr))}

      const sourcesCont=document.getElementById('sources-container');
      const addBtn=document.getElementById('add-source');
      const genBtn=document.getElementById('generate');
      const refBtn=document.getElementById('refresh-generate');
      const downBtn=document.getElementById('download');
      const copyResBtn=document.getElementById('copy-result');
      const configIn=document.getElementById('config-input');
      const outArea=document.getElementById('output');
      const resDiv=document.getElementById('result');
      const statusDiv=document.getElementById('status');
      const importBtn=document.getElementById('import-file-btn');
      const linkBox=document.getElementById('subscription-link-box');
      const linkText=document.getElementById('subscription-link-text');
      const copyLinkBtn=document.getElementById('copy-permanent-link');
      const noLink=document.getElementById('no-link-hint');
      const permalinkBase=location.origin+'/api/latest';

      function collectSources(){const rows=document.querySelectorAll('.source-row');const a=[];rows.forEach(r=>{const n=r.querySelector('.name').value.trim(),u=r.querySelector('.url').value.trim(),t=r.querySelector('.type').value;if(n||u)a.push({name:n,url:u,type:t})});return a}
      let saveT;function scheduleSave(){clearTimeout(saveT);saveT=setTimeout(()=>{saveSources(collectSources());saveConfigToDB(configIn.value)},300)}
      async function updateCacheIndicators(){const rows=document.querySelectorAll('.source-row');for(const r of rows){const u=r.querySelector('.url');if(!u)continue;const url=u.value.trim();if(!url)continue;const cache=await getProxyCache(url);let sp=r.querySelector('.cache-status');if(!sp){sp=document.createElement('span');sp.className='cache-status';r.appendChild(sp)}sp.textContent=cache?'缓存: '+cache.proxies.length+' 节点 ('+new Date(cache.timestamp).toLocaleString()+')':'无缓存'}}
      function createSourceRow(name='',url='',type='selector'){const d=document.createElement('div');d.className='source-row';d.innerHTML=\`<input class="name" placeholder="组名" value="\${name}"><input class="url" placeholder="URL" value="\${url}"><select class="type"><option value="selector" \${type==='selector'?'selected':''}>selector</option><option value="urltest" \${type==='urltest'?'selected':''}>urltest</option></select><span class="remove-btn-wrapper"><button class="remove-btn">✕</button></span>\`;d.querySelector('.remove-btn').onclick=()=>{d.remove();scheduleSave();updateCacheIndicators()};d.querySelectorAll('input,select').forEach(el=>{el.oninput=scheduleSave;el.onchange=scheduleSave});return d}
      function renderSources(srcs){sourcesCont.innerHTML='';srcs.forEach(s=>sourcesCont.appendChild(createSourceRow(s.name,s.url,s.type)));updateCacheIndicators()}
      async function fetchFromBackend(srcs){const r=await fetch('/api/fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sources:srcs})});if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||'请求失败')}const d=await r.json();return d.results}
      function parseJSONSafe(t){const f=t.replace(/,(\\s*[}\\]])/g,'$1');try{return JSON.parse(f)}catch(e){throw new Error('JSON格式错误：'+e.message)}}

      async function doGenerate(force){
        statusDiv.innerHTML='';resDiv.style.display='none';downBtn.style.display='none';copyResBtn.style.display='none';
        const rows=document.querySelectorAll('.source-row');const sources=[];
        for(const r of rows){const n=r.querySelector('.name').value.trim(),u=r.querySelector('.url').value.trim(),t=r.querySelector('.type').value;if(!n||!u){statusDiv.innerHTML='<span class="error">请填写所有组名和URL</span>';return}sources.push({name:n,url:u,type:t})}
        let configObj={};const configText=configIn.value.trim();
        if(configText){try{configObj=parseJSONSafe(configText)}catch(e){statusDiv.innerHTML='<span class="error">'+e.message+'</span>';return}}
        saveSources(sources);saveConfigToDB(configText);statusDiv.textContent='正在拉取...';
        const toFetch=[],fromCache=[];
        for(const s of sources){if(!force){const c=await getProxyCache(s.url);if(c){fromCache.push({...s,proxies:c.proxies,group:c.group,fromCache:true,error:null});continue}}toFetch.push(s)}
        let fetched=[];
        if(toFetch.length){try{fetched=await fetchFromBackend(toFetch)}catch(e){for(const s of toFetch){const c=await getProxyCache(s.url);if(c){fromCache.push({...s,proxies:c.proxies,group:c.group,fromCache:true,error:e.message})}else{fromCache.push({...s,proxies:[],group:null,fromCache:false,error:e.message})}}}}
        const all=[...fromCache];
        for(const res of fetched){if(!res.error){await saveProxyCache(res.url,res.proxies,res.group);all.push({...res,fromCache:false})}else{const c=await getProxyCache(res.url);if(c){all.push({...res,proxies:c.proxies,group:c.group,fromCache:true,error:res.error})}else{all.push({...res,fromCache:false})}}}
        const allProxies=[],allGroups=[],errors=[],cInfos=[];
        all.forEach(r=>{if(r.error){if(r.fromCache){cInfos.push('['+r.name+'] 拉取失败，使用缓存('+r.proxies.length+'节点)');allProxies.push(...r.proxies);if(r.group)allGroups.push(r.group)}else{errors.push('['+r.name+'] '+r.error)}}else{if(r.fromCache)cInfos.push('['+r.name+'] 使用缓存('+r.proxies.length+'节点)');allProxies.push(...r.proxies);if(r.group)allGroups.push(r.group)}});
        let statusHTML='';if(errors.length)statusHTML+='<span class="error">⚠ '+errors.join('; ')+'</span><br>';if(cInfos.length)statusHTML+='<span class="info">ℹ️ '+cInfos.join('; ')+'</span>';if(!errors.length&&!cInfos.length)statusHTML='<span class="success">✅ 生成成功</span>';else if(!errors.length)statusHTML+='<span class="success">✅ 生成成功（使用缓存）</span>';
        statusDiv.innerHTML=statusHTML;
        const userOut=Array.isArray(configObj.outbounds)?configObj.outbounds:[];
        const finalOut=[...userOut,...allProxies,...allGroups];
        const {outbounds:_,...rest}=configObj;
        const finalCfg={...rest,outbounds:finalOut};
        const json=JSON.stringify(finalCfg,null,2);
        outArea.value=json;resDiv.style.display='block';downBtn.style.display='inline-block';copyResBtn.style.display='inline-block';
        try{await fetch('/api/update',{method:'POST',headers:{'Content-Type':'application/json'},body:json});await savePermalink(permalinkBase);linkText.textContent=permalinkBase;linkBox.style.display='flex';noLink.style.display='none'}catch(e){}
        downBtn.onclick=()=>{const b=new Blob([json],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='sing-box-config.json';a.click()};
        copyResBtn.onclick=async()=>{try{await navigator.clipboard.writeText(json);copyResBtn.textContent='✅ 已复制';setTimeout(()=>copyResBtn.textContent='📋 复制',2000)}catch(e){copyResBtn.textContent='❌ 失败';setTimeout(()=>copyResBtn.textContent='📋 复制',2000)}};
        updateCacheIndicators();
      }
      genBtn.onclick=()=>doGenerate(false);
      refBtn.onclick=()=>doGenerate(true);
      addBtn.onclick=()=>{sourcesCont.appendChild(createSourceRow());scheduleSave();updateCacheIndicators()};
      configIn.oninput=scheduleSave;
      importBtn.onclick=()=>{const inp=document.createElement('input');inp.type='file';inp.accept='.json,.txt';inp.onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>{configIn.value=ev.target.result;scheduleSave()};r.readAsText(f)};inp.click()};
      copyLinkBtn.onclick=async()=>{try{await navigator.clipboard.writeText(linkText.textContent);copyLinkBtn.textContent='✅ 已复制';setTimeout(()=>copyLinkBtn.textContent='📋 复制',2000)}catch(e){copyLinkBtn.textContent='❌ 失败';setTimeout(()=>copyLinkBtn.textContent='📋 复制',2000)}};
      (async function init(){const srcs=loadSources();renderSources(srcs);const cfg=await loadConfigFromDB();if(cfg)configIn.value=cfg;const link=await loadPermalink();if(link){linkText.textContent=link;linkBox.style.display='flex';noLink.style.display='none'}})();
    })();
  </script>
</body>
</html>`;
  }
