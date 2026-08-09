// _workers.js - 最终版：Sing-Box & Clash 订阅合并器
// 支持 JSON (Sing-Box) 与 YAML (Clash) 源，输出永久 Sing-Box JSON

// 内存后备存储
const memoryStore = new Map();
// 自动排除的组类型
const EXCLUDED_TYPES = ['direct', 'selector', 'urltest', 'dns', 'block'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预处理
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 主页
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 后端拉取代理
    if (url.pathname === '/api/fetch' && request.method === 'POST') {
      return handleFetchProxies(request);
    }

    // 更新永久订阅
    if (url.pathname === '/api/update' && request.method === 'POST') {
      return handleUpdate(request, env);
    }

    // 获取永久订阅
    if (url.pathname === '/api/latest' && request.method === 'GET') {
      return handleGetLatest(env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

/* ==================================================
   拉取并解析多个源（JSON/YAML），返回标准化代理列表
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
          headers: { 'User-Agent': 'SubMerger/2.0' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        let text = await resp.text();

        // 可能为 Base64 编码，尝试解码
        try {
          const decoded = atob(text.trim());
          // 若解码后看起来像 JSON 或 YAML 则采用
          if (decoded.trim().startsWith('{') || decoded.trim().startsWith('[') || decoded.includes('proxies:')) {
            text = decoded;
          }
        } catch (_) {}

        let outbounds = [];

        // 1. 尝试按 JSON 解析 (Sing-Box)
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            outbounds = data;
          } else if (data.outbounds && Array.isArray(data.outbounds)) {
            outbounds = data.outbounds;
          }
        } catch (_) {}

        // 2. 若不是 JSON，尝试解析 Clash YAML（提取 proxies 部分）
        if (outbounds.length === 0) {
          const clashProxies = parseClashProxies(text);
          if (clashProxies.length > 0) {
            outbounds = convertClashToSingBox(clashProxies);
          }
        }

        if (outbounds.length === 0) throw new Error('无法识别格式或无有效节点');

        // 过滤不需要的类型
        const filtered = outbounds.filter(
          (ob) => ob && typeof ob === 'object' && !EXCLUDED_TYPES.includes(ob.type)
        );
        const proxies = filtered.map((ob) => ({
          ...ob,
          tag: ob.tag || 'unnamed',
        }));

        if (!proxies.length) return { name, url, proxies: [], group: null, error: '该源无有效代理节点' };

        const tags = proxies.map((p) => p.tag);
        const group = { type, tag: name, outbounds: tags };
        // 只有 selector 才添加 default
        if (type === 'selector') group.default = tags[0] || '';

        return { name, url, proxies, group, error: null };
      } catch (e) {
        return { name, url, proxies: [], group: null, error: e.message };
      }
    });

    const results = await Promise.all(tasks);

    // 全局 tag 去重（追加源名称后缀）
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
      // 更新 group 的 outbounds 列表
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

/* ==================================================
   从 Clash YAML 文本提取 proxies 列表
   (仅解析 - name: xxx 开头的块，直到缩进结束或下一个顶级键)
   ================================================== */
function parseClashProxies(text) {
  const lines = text.split(/\r?\n/);
  const proxies = [];
  let inProxies = false;
  let currentProxy = null;
  let currentIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // 忽略注释和空行
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;

    const indent = raw.search(/\S/);
    const content = line.trim();

    // 检测 "proxies:" 键（通常在顶层）
    if (!inProxies && content === 'proxies:') {
      inProxies = true;
      continue;
    }

    if (inProxies) {
      // 遇到下一个非缩进键，结束解析
      if (indent === 0 && content !== 'proxies:' && !content.startsWith('-')) {
        break;
      }

      // 新代理项
      if (content.startsWith('- ')) {
        if (currentProxy) proxies.push(currentProxy);
        currentProxy = {};
        // 处理 "- name: xxx" 或 "- {name: xxx, ...}" 等简单情况
        const rest = content.substring(2).trim();
        if (rest.includes(':')) {
          const kv = splitKeyValue(rest);
          if (kv) currentProxy[kv.key] = kv.value;
        }
        currentIndent = indent;
      } else if (currentProxy && indent > currentIndent) {
        // 代理的属性行
        const kv = splitKeyValue(content);
        if (kv) {
          // 多行字符串或数组等简单值，这里仅支持单行值
          currentProxy[kv.key] = kv.value;
        }
      } else if (currentProxy && indent <= currentIndent) {
        // 缩进回退，代理结束
        proxies.push(currentProxy);
        currentProxy = null;
        // 重新检查本行是否是新项
        if (content.startsWith('- ')) {
          const rest = content.substring(2).trim();
          currentProxy = {};
          const kv = splitKeyValue(rest);
          if (kv) currentProxy[kv.key] = kv.value;
          currentIndent = indent;
        } else {
          // 可能遇到其他顶级键，结束
          break;
        }
      }
    }
  }
  if (currentProxy) proxies.push(currentProxy);
  return proxies;
}

// 辅助：分割 "key: value" 或 "key:"
function splitKeyValue(str) {
  const idx = str.indexOf(':');
  if (idx === -1) return null;
  const key = str.substring(0, idx).trim();
  let value = str.substring(idx + 1).trim();
  // 去除可能的引号
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/* ==================================================
   将 Clash 代理对象数组转换为 Sing-Box 出站格式
   ================================================== */
function convertClashToSingBox(clashProxies) {
  return clashProxies.map((p) => {
    const base = { tag: p.name || p.server || 'unknown' };
    switch (p.type) {
      case 'ss':
        return {
          ...base,
          type: 'shadowsocks',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          method: p.cipher || 'aes-256-gcm',
          password: p.password,
        };
      case 'vmess':
        return {
          ...base,
          type: 'vmess',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          uuid: p.uuid,
          security: p.cipher || 'auto',
          alter_id: parseInt(p.alterId) || 0,
        };
      case 'trojan':
        return {
          ...base,
          type: 'trojan',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          password: p.password,
          ...(p.sni ? { tls: { enabled: true, server_name: p.sni } } : {}),
        };
      case 'http':
        return {
          ...base,
          type: 'http',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          username: p.username || '',
          password: p.password || '',
        };
      case 'socks5':
        return {
          ...base,
          type: 'socks',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          username: p.username || '',
          password: p.password || '',
        };
      default:
        return null;
    }
  }).filter(Boolean);
}

/* ==================================================
   永久订阅链接处理
   ================================================== */
async function handleUpdate(request, env) {
  const configStr = JSON.stringify(await request.json());
  if (env.SUB_CONFIG) {
    await env.SUB_CONFIG.put('latest', configStr);
  } else {
    memoryStore.set('latest', configStr);
  }
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function handleGetLatest(env) {
  const config = env.SUB_CONFIG
    ? await env.SUB_CONFIG.get('latest', 'text')
    : memoryStore.get('latest');
  if (config) {
    return new Response(config, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });
  }
  return new Response('尚未生成任何配置', { status: 404 });
}

/* ==================================================
   前端 HTML 页面（包含完整的交互逻辑）
   ================================================== */
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sing-Box / Clash 订阅合并器</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 1rem; background: #f2f2f7; color: #1c1c1e; line-height: 1.5; }
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
  <h1>🔀 Sing-Box / Clash 订阅合并器</h1>
  <p style="color: #6e6e73;">支持 JSON (Sing-Box) 和 YAML (Clash) 格式的订阅源，自动提取代理节点并合并为 Sing-Box 配置。</p>

  <div class="card">
    <h2>🔗 永久订阅链接</h2>
    <p style="color: #6e6e73; font-size: 0.85rem;">每次生成后自动更新。可导入 Sing-Box 客户端。</p>
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
    // ========== 完整前端逻辑 ==========
    (function() {
      const DB_NAME = 'sub-merger';
      const DB_VERSION = 3;
      const CONFIG_STORE = 'config';
      const CACHE_STORE = 'cache';
      const META_STORE = 'meta';
      const PERMALINK_KEY = 'permalink';
      const SOURCES_KEY = 'sources';

      let db = null;

      // ---------- IndexedDB 封装 ----------
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
          return new Promise((res, rej) => { req.onsuccess = () => res(req.result ? req.result.value : ''); req.onerror = rej; });
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
          return new Promise((res, rej) => { req.onsuccess = () => res(req.result || null); req.onerror = rej; });
        } catch(e) { return null; }
      }

      async function savePermanentLink(link) {
        try {
          const d = await openDB();
          const tx = d.transaction(META_STORE, 'readwrite');
          tx.objectStore(META_STORE).put({ id: PERMALINK_KEY, value: link });
          return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        } catch(e) {}
      }

      async function loadPermanentLink() {
        try {
          const d = await openDB();
          const tx = d.transaction(META_STORE, 'readonly');
          const req = tx.objectStore(META_STORE).get(PERMALINK_KEY);
          return new Promise((res, rej) => { req.onsuccess = () => res(req.result ? req.result.value : ''); req.onerror = rej; });
        } catch(e) { return ''; }
      }

      // ---------- 订阅源列表 localStorage ----------
      function loadSources() {
        try {
          const s = localStorage.getItem(SOURCES_KEY);
          if (s) return JSON.parse(s);
        } catch(e) {}
        return [{ name: 'HK', url: 'https://example.com/sub', type: 'selector' }];
      }

      function saveSources(arr) {
        localStorage.setItem(SOURCES_KEY, JSON.stringify(arr));
      }

      // ---------- UI 元素 ----------
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

      // ---------- 辅助函数 ----------
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
        div.innerHTML = \`
          <input class="name" placeholder="组名" value="\${name}">
          <input class="url" placeholder="订阅源 URL" value="\${url}">
          <select class="type">
            <option value="selector" \${type==='selector'?'selected':''}>selector</option>
            <option value="urltest" \${type==='urltest'?'selected':''}>urltest</option>
          </select>
          <span class="remove-btn-wrapper"><button class="remove-btn">✕</button></span>
        \`;
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

      // ---------- 与后端通信 ----------
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

      // ---------- 核心生成逻辑 ----------
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

        // 决定哪些需要远程拉取
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
          await savePermanentLink(permalinkBase);
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
// _workers.js – Sing‑Box & Clash 订阅合并器（支持 vless/anytls）
// 部署时建议绑定 KV 命名空间至变量 SUB_CONFIG

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

/* ========== 拉取并解析多个源（JSON/YAML） ========== */
async function handleFetchProxies(request) {
  try {
    const { sources } = await request.json();
    if (!Array.isArray(sources) || sources.length === 0) throw new Error('至少需要一个订阅源');

    const tasks = sources.map(async (src) => {
      const { name, url, type = 'selector' } = src;
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'SubMerger/2.0' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        let text = await resp.text();

        // 尝试 Base64 解码
        try {
          const decoded = atob(text.trim());
          if (decoded.trim().startsWith('{') || decoded.trim().startsWith('[') || decoded.includes('proxies:')) {
            text = decoded;
          }
        } catch (_) {}

        let outbounds = [];

        // 1. 尝试 JSON
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            outbounds = data;
          } else if (data.outbounds && Array.isArray(data.outbounds)) {
            outbounds = data.outbounds;
          }
        } catch (_) {}

        // 2. 尝试 Clash YAML
        if (outbounds.length === 0) {
          const clashProxies = parseClashProxies(text);
          if (clashProxies.length > 0) {
            outbounds = convertClashToSingBox(clashProxies);
          }
        }

        if (outbounds.length === 0) throw new Error('无法识别格式或无有效节点');

        const filtered = outbounds.filter(
          (ob) => ob && typeof ob === 'object' && !EXCLUDED_TYPES.includes(ob.type)
        );
        const proxies = filtered.map((ob) => ({
          ...ob,
          tag: ob.tag || 'unnamed',
        }));

        if (!proxies.length) return { name, url, proxies: [], group: null, error: '该源无有效代理节点' };

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

/* ========== 从 Clash YAML 提取 proxies ========== */
function parseClashProxies(text) {
  const lines = text.split(/\r?\n/);
  const proxies = [];
  let inProxies = false;
  let currentProxy = null;
  let currentIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;

    const indent = raw.search(/\S/);
    const content = line.trim();

    if (!inProxies && content === 'proxies:') {
      inProxies = true;
      continue;
    }

    if (inProxies) {
      if (indent === 0 && content !== 'proxies:' && !content.startsWith('-')) break;

      if (content.startsWith('- ')) {
        if (currentProxy) proxies.push(currentProxy);
        currentProxy = {};
        const rest = content.substring(2).trim();
        if (rest.includes(':')) {
          const kv = splitKeyValue(rest);
          if (kv) currentProxy[kv.key] = kv.value;
        }
        currentIndent = indent;
      } else if (currentProxy && indent > currentIndent) {
        const kv = splitKeyValue(content);
        if (kv) currentProxy[kv.key] = kv.value;
      } else if (currentProxy && indent <= currentIndent) {
        proxies.push(currentProxy);
        currentProxy = null;
        if (content.startsWith('- ')) {
          const rest = content.substring(2).trim();
          currentProxy = {};
          const kv = splitKeyValue(rest);
          if (kv) currentProxy[kv.key] = kv.value;
          currentIndent = indent;
        } else break;
      }
    }
  }
  if (currentProxy) proxies.push(currentProxy);
  return proxies;
}

function splitKeyValue(str) {
  const idx = str.indexOf(':');
  if (idx === -1) return null;
  const key = str.substring(0, idx).trim();
  let value = str.substring(idx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/* ========== Clash 代理 → Sing‑Box 出站 ========== */
function convertClashToSingBox(clashProxies) {
  return clashProxies.map((p) => {
    const base = { tag: p.name || p.server || 'unknown' };
    switch (p.type) {
      case 'ss':
        return {
          ...base,
          type: 'shadowsocks',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          method: p.cipher || 'aes-256-gcm',
          password: p.password,
        };
      case 'vmess':
        return {
          ...base,
          type: 'vmess',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          uuid: p.uuid,
          security: p.cipher || 'auto',
          alter_id: parseInt(p.alterId) || 0,
        };
      case 'trojan':
        const trojan = {
          ...base,
          type: 'trojan',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          password: p.password,
        };
        if (p.sni || p.servername) trojan.tls = { enabled: true, server_name: p.sni || p.servername };
        return trojan;
      case 'vless':
        const vless = {
          ...base,
          type: 'vless',
          server: p.server,
          server_port: parseInt(p.port) || 443,
          uuid: p.uuid,
        };
        if (p.flow) vless.flow = p.flow;
        if (p.tls) {
          vless.tls = { enabled: true };
          if (p.servername) vless.tls.server_name = p.servername;
          if (p['reality-opts']) {
            vless.tls.reality = { enabled: true };
            if (p['reality-opts'].public_key) vless.tls.reality.public_key = p['reality-opts'].public_key;
            if (p['reality-opts'].short_id) vless.tls.reality.short_id = p['reality-opts'].short_id;
          }
        }
        if (p.network) {
          vless.transport = { type: p.network };
          if (p.network === 'ws') {
            if (p.ws_opts?.path) vless.transport.path = p.ws_opts.path;
            if (p.ws_opts?.headers?.Host) vless.transport.headers = { Host: p.ws_opts.headers.Host };
          } else if (p.network === 'grpc') {
            if (p.grpc_opts?.serviceName) vless.transport.service_name = p.grpc_opts.serviceName;
          }
        }
        return vless;
      case 'anytls':
        const anytls = {
          ...base,
          type: 'anytls',
          server: p.server,
          server_port: parseInt(p.port) || 443,
          password: p.password,
          tls: {},
        };
        if (p.sni || p.servername) anytls.tls.server_name = p.sni || p.servername;
        if (Object.keys(anytls.tls).length === 0) delete anytls.tls;
        return anytls;
      case 'http':
        return {
          ...base,
          type: 'http',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          username: p.username || '',
          password: p.password || '',
        };
      case 'socks5':
        return {
          ...base,
          type: 'socks',
          server: p.server,
          server_port: parseInt(p.port) || 0,
          username: p.username || '',
          password: p.password || '',
        };
      default:
        return null;
    }
  }).filter(Boolean);
}

/* ========== 永久订阅链接 ========== */
async function handleUpdate(request, env) {
  const configStr = JSON.stringify(await request.json());
  if (env.SUB_CONFIG) {
    await env.SUB_CONFIG.put('latest', configStr);
  } else {
    memoryStore.set('latest', configStr);
  }
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function handleGetLatest(env) {
  const config = env.SUB_CONFIG
    ? await env.SUB_CONFIG.get('latest', 'text')
    : memoryStore.get('latest');
  if (config) {
    return new Response(config, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });
  }
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
  <p>支持 JSON (Sing‑Box) 与 YAML (Clash) 格式源，自动合并为 Sing‑Box 配置（含 vless/anytls）。</p>

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
      function openDB() { return new Promise((res, rej) => {
        if(db) return res(db);
        const req=indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded= e => {
          const d=e.target.result;
          if(!d.objectStoreNames.contains(CONFIG_STORE)) d.createObjectStore(CONFIG_STORE,{keyPath:'id'});
          if(!d.objectStoreNames.contains(CACHE_STORE)) d.createObjectStore(CACHE_STORE,{keyPath:'url'});
          if(!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE,{keyPath:'id'});
        };
        req.onsuccess= e => { db=e.target.result; res(db); };
        req.onerror= e => rej(e.target.error);
      })}
      async function saveConfigToDB(text){try{const d=await openDB(); const tx=d.transaction(CONFIG_STORE,'readwrite'); tx.objectStore(CONFIG_STORE).put({id:'cfg',value:text}); return new Promise(r=>tx.oncomplete=r)}catch(e){}}
      async function loadConfigFromDB(){try{const d=await openDB(); const tx=d.transaction(CONFIG_STORE,'readonly'); const req=tx.objectStore(CONFIG_STORE).get('cfg'); return new Promise(r=>req.onsuccess=()=>r(req.result?req.result.value:''))}catch(e){return''}}
      async function saveProxyCache(url,proxies,group){try{const d=await openDB(); const tx=d.transaction(CACHE_STORE,'readwrite'); tx.objectStore(CACHE_STORE).put({url,proxies,group,timestamp:Date.now()}); return new Promise(r=>tx.oncomplete=r)}catch(e){}}
      async function getProxyCache(url){try{const d=await openDB(); const tx=d.transaction(CACHE_STORE,'readonly'); const req=tx.objectStore(CACHE_STORE).get(url); return new Promise(r=>req.onsuccess=()=>r(req.result||null))}catch(e){return null}}
      async function savePermalink(link){try{const d=await openDB(); const tx=d.transaction(META_STORE,'readwrite'); tx.objectStore(META_STORE).put({id:PERMALINK_KEY,value:link}); return new Promise(r=>tx.oncomplete=r)}catch(e){}}
      async function loadPermalink(){try{const d=await openDB(); const tx=d.transaction(META_STORE,'readonly'); const req=tx.objectStore(META_STORE).get(PERMALINK_KEY); return new Promise(r=>req.onsuccess=()=>r(req.result?req.result.value:''))}catch(e){return''}}

      function loadSources(){try{const s=localStorage.getItem(SOURCES_KEY); return s?JSON.parse(s):[{name:'HK',url:'https://example.com/sub',type:'selector'}]}catch(e){return[{name:'HK',url:'https://example.com/sub',type:'selector'}]}}
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

      function collectSources(){const rows=document.querySelectorAll('.source-row'); const a=[]; rows.forEach(r=>{const n=r.querySelector('.name').value.trim(),u=r.querySelector('.url').value.trim(),t=r.querySelector('.type').value; if(n||u) a.push({name:n,url:u,type:t})}); return a}
      let saveT; function scheduleSave(){clearTimeout(saveT); saveT=setTimeout(()=>{saveSources(collectSources()); saveConfigToDB(configIn.value)},300)}
      async function updateCacheIndicators(){const rows=document.querySelectorAll('.source-row'); for(const r of rows){const u=r.querySelector('.url'); if(!u) continue; const url=u.value.trim(); if(!url) continue; const cache=await getProxyCache(url); let sp=r.querySelector('.cache-status'); if(!sp){sp=document.createElement('span'); sp.className='cache-status'; r.appendChild(sp)} sp.textContent=cache?'缓存: '+cache.proxies.length+' 节点 ('+new Date(cache.timestamp).toLocaleString()+')':'无缓存'}}
      function createSourceRow(name='',url='',type='selector'){const d=document.createElement('div'); d.className='source-row'; d.innerHTML=\`<input class="name" placeholder="组名" value="\${name}"><input class="url" placeholder="URL" value="\${url}"><select class="type"><option value="selector" \${type==='selector'?'selected':''}>selector</option><option value="urltest" \${type==='urltest'?'selected':''}>urltest</option></select><span class="remove-btn-wrapper"><button class="remove-btn">✕</button></span>\`; d.querySelector('.remove-btn').onclick=()=>{d.remove(); scheduleSave(); updateCacheIndicators()}; d.querySelectorAll('input,select').forEach(el=>{el.oninput=scheduleSave; el.onchange=scheduleSave}); return d}
      function renderSources(srcs){sourcesCont.innerHTML=''; srcs.forEach(s=>sourcesCont.appendChild(createSourceRow(s.name,s.url,s.type))); updateCacheIndicators()}
      async function fetchFromBackend(srcs){const r=await fetch('/api/fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sources:srcs})}); if(!r.ok){const e=await r.json().catch(()=>({})); throw new Error(e.error||'请求失败')} const d=await r.json(); return d.results}
      function parseJSONSafe(t){const f=t.replace(/,(\\s*[}\\]])/g,'$1'); try{return JSON.parse(f)}catch(e){throw new Error('JSON格式错误：'+e.message)}}

      async function doGenerate(force){
        statusDiv.innerHTML=''; resDiv.style.display='none'; downBtn.style.display='none'; copyResBtn.style.display='none';
        const rows=document.querySelectorAll('.source-row
, async () => {
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
        const savedLink = await loadPermanentLink();
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
