const express = require('express');
const fs = require('fs');
const path = require('path');
const { ProxyAgent } = require('undici');

const REQUEST_TIMEOUT = 15000;

const app = express();
const PORT = process.env.PORT || 3000;
const API_CONFIG_PATH = path.join(__dirname, '..', 'config', 'api.config.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function loadApiConfig() {
  if (!fs.existsSync(API_CONFIG_PATH)) {
    throw new Error('Missing config/api.config.json');
  }

  const raw = fs.readFileSync(API_CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed.login || !parsed.invite) {
    throw new Error('api.config.json must include both login and invite sections.');
  }

  return parsed;
}

function saveApiConfig(config) {
  fs.writeFileSync(API_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function getProxyMode() {
  try {
    const config = loadApiConfig();
    return config.proxy || { mode: 'direct', custom_url: '' };
  } catch {
    return { mode: 'direct', custom_url: '' };
  }
}

function getByPath(obj, pathExpr) {
  if (!pathExpr) return undefined;
  const normalized = pathExpr.replace(/^\$\.?/, '');
  return normalized.split('.').reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, obj);
}

function parseRuleExpected(rawExpected) {
  const expected = rawExpected.trim();
  if (expected === 'true') return true;
  if (expected === 'false') return false;
  if (expected === 'null') return null;
  if (!Number.isNaN(Number(expected)) && expected !== '') return Number(expected);
  if (
    (expected.startsWith('"') && expected.endsWith('"')) ||
    (expected.startsWith("'") && expected.endsWith("'"))
  ) {
    return expected.slice(1, -1);
  }
  return expected;
}

function evaluateSuccessRule(payload, rule) {
  if (!rule) return true;
  const m = String(rule).match(/^([$.\w]+)\s*==\s*(.+)$/);
  if (!m) {
    throw new Error(`Unsupported success_rule: ${rule}. Use format like code==0 or data.ok==true`);
  }

  const [, left, right] = m;
  const actual = getByPath(payload, left);
  const expected = parseRuleExpected(right);
  return actual === expected;
}

function renderTemplate(input, vars) {
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    return input.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key) => {
      const v = getByPath(vars, key.trim());
      if (v === undefined || v === null) return '';
      return String(v);
    });
  }

  if (Array.isArray(input)) {
    return input.map((item) => renderTemplate(item, vars));
  }

  if (typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, renderTemplate(v, vars)]));
  }

  return input;
}

function parseResponse(response, text) {
  const contentType = response.headers.get('content-type') || '';
  let body;
  if (contentType.includes('application/json') && text.trim()) {
    try { body = JSON.parse(text); } catch { body = text; }
  } else {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

let cachedOutboundIp = null;

async function getOutboundIp() {
  if (cachedOutboundIp) return cachedOutboundIp;
  try {
    const resp = await fetch('https://httpbin.org/ip', { signal: AbortSignal.timeout(4000) });
    const data = await resp.json();
    cachedOutboundIp = data.origin || '直连';
  } catch {
    cachedOutboundIp = '直连';
  }
  return cachedOutboundIp;
}

async function requestJson(url, options, modeOverride) {
  const proxyConf = modeOverride ? { mode: modeOverride } : getProxyMode();

  // ── direct mode ──
  if (proxyConf.mode === 'direct') {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT)
      });
      const text = await response.text();
      const ip = await getOutboundIp();
      return { ...parseResponse(response, text), proxy_used: ip };
    } catch (err) {
      const cause = err.cause ? (err.cause.message || err.cause.code) : err.message;
      console.error(`[requestJson direct] ${url} 失败:`, cause);
      throw err;
    }
  }

  // ── custom proxy mode ──
  if (proxyConf.mode === 'custom') {
    const customUrl = (proxyConf.custom_url || '').trim();
    if (!customUrl) {
      throw new Error('自定义代理地址为空，请在设置中填写代理地址');
    }
    const agent = new ProxyAgent(customUrl);
    const response = await fetch(url, {
      ...options,
      dispatcher: agent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });
    const text = await response.text();
    return { ...parseResponse(response, text), proxy_used: customUrl.replace(/\/\/.*@/, '//***@') };
  }

  // ── Scrape.do API 模式 ──
  if (proxyConf.mode === 'scrape_do') {
    const token = (proxyConf.scrape_do_token || '').trim();
    if (!token) {
      throw new Error('请填写 Scrape.do API Token');
    }
    const apiUrl = `https://api.scrape.do?token=${encodeURIComponent(token)}&url=${encodeURIComponent(url)}&forwardHeaders=true`;
    try {
      const response = await fetch(apiUrl, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(30000)
      });
      const text = await response.text();
      return { ...parseResponse(response, text), proxy_used: 'scrape.do' };
    } catch (err) {
      const cause = err.cause ? (err.cause.message || err.cause.code) : err.message;
      console.error(`[requestJson scrape.do] ${url} 失败:`, cause);
      throw err;
    }
  }

  throw new Error(`不支持的代理模式: ${proxyConf.mode}`);
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }).toUpperCase();
}

function generateRandomDevice(appV) {
  const models = [
    'Xiaomi 14', 'OPPO Find X7', 'vivo X100', 'Samsung Galaxy S24',
    'Huawei Mate 60', 'OnePlus 12', 'Redmi K70', 'realme GT5',
    'Xiaomi 13', 'OPPO Reno11', 'vivo S18', 'Samsung Galaxy A55',
    'Huawei nova 12', 'OnePlus Ace 3', 'Redmi Note 13', 'realme 12 Pro'
  ];
  const osVersions = ['12', '13', '14', '15'];

  return {
    uId: generateUUID(),
    plt: 'Android',
    osV: randomItem(osVersions),
    appV: appV || '1.2.0',
    mdl: randomItem(models),
    isE: false
  };
}

// ── 好主码 (haozhuma) SMS platform client ──

function getHzmConfig() {
  const config = loadApiConfig();
  return config.haozhuma || {};
}

function saveHzmToken(token) {
  const config = loadApiConfig();
  if (!config.haozhuma) config.haozhuma = {};
  config.haozhuma.token = token;
  saveApiConfig(config);
}

async function hzmRequest(server, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${server}/sms/?${qs}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`好主码返回非JSON: ${text.slice(0, 200)}`);
  }
}

async function hzmLogin(server, user, pass) {
  const data = await hzmRequest(server, { api: 'login', user, pass });
  if (String(data.code) !== '0' && String(data.code) !== '200') {
    throw new Error(`好主码登录失败: ${data.msg || JSON.stringify(data)}`);
  }
  return data.token;
}

async function hzmGetPhone(server, token, sid) {
  const data = await hzmRequest(server, { api: 'getPhone', token, sid });
  if (String(data.code) !== '0') {
    throw new Error(`获取号码失败: ${data.msg || JSON.stringify(data)}`);
  }
  return data.phone;
}

async function hzmGetMessage(server, token, sid, phone, { maxWaitMs = 180000, isCancelled } = {}) {
  const pollInterval = 15000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    if (isCancelled && isCancelled()) return null;
    const data = await hzmRequest(server, { api: 'getMessage', token, sid, phone });
    if (String(data.code) === '0' && data.yzm) {
      return data.yzm;
    }
    if (Date.now() + pollInterval >= deadline) break;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return null; // timeout
}

async function hzmCancelRecv(server, token, sid, phone) {
  try {
    await hzmRequest(server, { api: 'cancelRecv', token, sid, phone });
  } catch { /* ignore */ }
}

async function hzmAddBlacklist(server, token, sid, phone) {
  try {
    await hzmRequest(server, { api: 'addBlacklist', token, sid, phone });
  } catch { /* ignore */ }
}

async function runLoginAndInvite({ phone, code, inviteCode, device }, config) {
  const vars = {
    phone,
    code,
    invite_code: inviteCode,
    device: device || {},
    device_json: JSON.stringify(device || {})
  };

  const loginHeaders = renderTemplate(config.login.headers || {}, vars);
  const loginBody = renderTemplate(config.login.body_template || {}, vars);

  if (!Object.keys(loginHeaders).some((h) => h.toLowerCase() === 'content-type')) {
    loginHeaders['Content-Type'] = 'application/json';
  }

  const loginResp = await requestJson(config.login.url, {
    method: (config.login.method || 'POST').toUpperCase(),
    headers: loginHeaders,
    body: JSON.stringify(loginBody)
  });

  const proxies_used = [loginResp.proxy_used];

  if (loginResp.body === null || typeof loginResp.body !== 'object' || Array.isArray(loginResp.body)) {
    return {
      success: false,
      stage: 'login',
      reason: `Login response is not JSON (status ${loginResp.status})`,
      proxies_used
    };
  }

  if (config.login.success_rule) {
    const loginSuccess = evaluateSuccessRule(loginResp.body, config.login.success_rule);
    if (!loginSuccess) {
      return {
        success: false,
        stage: 'login',
        reason: `Login failed by success_rule. response=${JSON.stringify(loginResp.body).slice(0, 300)}`,
        proxies_used
      };
    }
  }

  const token = getByPath(loginResp.body, config.login.token_path);
  if (!token) {
    return {
      success: false,
      stage: 'login',
      reason: `Cannot find token at path: ${config.login.token_path}. response=${JSON.stringify(loginResp.body).slice(0, 300)}`,
      proxies_used
    };
  }

  const inviteVars = {
    ...vars,
    token
  };

  const inviteHeaders = renderTemplate(config.invite.headers || {}, inviteVars);
  const inviteBody = renderTemplate(config.invite.body_template || {}, inviteVars);

  if (config.invite.token && config.invite.token.placement === 'header') {
    inviteHeaders[config.invite.token.key || 'Authorization'] = renderTemplate(
      config.invite.token.template || 'Bearer {{token}}',
      inviteVars
    );
  }

  if (config.invite.token && config.invite.token.placement === 'body') {
    const targetPath = config.invite.token.path;
    if (!targetPath) {
      throw new Error('invite.token.path is required when placement=body');
    }

    const keys = targetPath.split('.');
    let cursor = inviteBody;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const k = keys[i];
      if (!cursor[k] || typeof cursor[k] !== 'object') {
        cursor[k] = {};
      }
      cursor = cursor[k];
    }
    cursor[keys[keys.length - 1]] = token;
  }

  if (!Object.keys(inviteHeaders).some((h) => h.toLowerCase() === 'content-type')) {
    inviteHeaders['Content-Type'] = 'application/json';
  }

  const inviteResp = await requestJson(config.invite.url, {
    method: (config.invite.method || 'POST').toUpperCase(),
    headers: inviteHeaders,
    body: JSON.stringify(inviteBody)
  });

  proxies_used.push(inviteResp.proxy_used);

  if (config.invite.success_rule) {
    if (inviteResp.body === null || typeof inviteResp.body !== 'object' || Array.isArray(inviteResp.body)) {
      return {
        success: false,
        stage: 'invite',
        reason: `Invite response is not JSON (status ${inviteResp.status})`,
        proxies_used
      };
    }
    const inviteSuccess = evaluateSuccessRule(inviteResp.body, config.invite.success_rule);
    if (!inviteSuccess) {
      return {
        success: false,
        stage: 'invite',
        reason: `Invite failed by success_rule. response=${JSON.stringify(inviteResp.body).slice(0, 300)}`,
        proxies_used
      };
    }
  } else if (!inviteResp.ok) {
    const detail = typeof inviteResp.body === 'string'
      ? inviteResp.body.slice(0, 300)
      : JSON.stringify(inviteResp.body).slice(0, 300);
    return {
      success: false,
      stage: 'invite',
      reason: `Invite failed with HTTP ${inviteResp.status}. ${detail}`,
      proxies_used
    };
  }

  return {
    success: true,
    token: String(token).slice(0, 12) + '...',
    loginResponse: loginResp.body,
    inviteResponse: inviteResp.body,
    proxies_used
  };
}

app.get('/api/health', (_, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get('/api/proxy-status', (_, res) => {
  const proxyConf = getProxyMode();
  if (proxyConf.mode === 'scrape_do') {
    return res.json({
      ok: true, mode: 'scrape_do',
      has_token: Boolean(proxyConf.scrape_do_token)
    });
  }
  res.json({
    ok: true, mode: proxyConf.mode,
    custom_url: proxyConf.mode === 'custom'
      ? (proxyConf.custom_url || '').replace(/\/\/.*@/, '//***@')
      : undefined
  });
});

app.get('/api/proxy-config', (_, res) => {
  const proxyConf = getProxyMode();
  res.json({ ok: true, proxy: proxyConf });
});

app.post('/api/proxy-config', (req, res) => {
  try {
    const { mode, custom_url, scrape_do_token } = req.body;
    if (!['custom', 'direct', 'scrape_do'].includes(mode)) {
      return res.status(400).json({ ok: false, error: '无效的代理模式' });
    }
    const config = loadApiConfig();
    config.proxy = { mode, custom_url: custom_url || '', scrape_do_token: scrape_do_token || '' };
    saveApiConfig(config);
    res.json({ ok: true, proxy: config.proxy });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/config-status', (_, res) => {
  try {
    const config = loadApiConfig();
    res.json({
      ok: true,
      login_url: config.login.url,
      invite_url: config.invite.url,
      has_token_path: Boolean(config.login.token_path)
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/api/send-sms', async (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (!phone) {
    return res.status(400).json({ ok: false, error: '手机号不能为空' });
  }

  try {
    const smsUrl = `https://www.ankangme.com/prod-api/resource/sms/code?phone=${encodeURIComponent(phone)}`;
    const result = await requestJson(smsUrl, { method: 'GET' });
    if (!result.ok) {
      const detail = typeof result.body === 'string' ? result.body.slice(0, 200) : JSON.stringify(result.body).slice(0, 200);
      return res.status(result.status).json({ ok: false, error: `SMS API returned ${result.status}: ${detail}` });
    }
    return res.json({ ok: true, message: '验证码已发送', proxy: result.proxy_used });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/run', async (req, res) => {
  try {
    const config = loadApiConfig();
    const inviteCode = String(req.body.inviteCode || '').trim();
    if (!inviteCode) {
      return res.status(400).json({ ok: false, error: '邀请码不能为空' });
    }

    const phone = String(req.body.phone || '').trim();
    const code = String(req.body.code || '').trim();
    if (!phone || !code) {
      return res.status(400).json({ ok: false, error: '手机号和验证码不能为空' });
    }

    const appVersion = String(req.body.appVersion || '1.0.0').trim();
    const device = generateRandomDevice(appVersion);

    const output = await runLoginAndInvite({ phone, code, inviteCode, device }, config);

    return res.json({
      ok: true,
      phone,
      success: output.success,
      stage: output.stage || null,
      reason: output.reason || null,
      token_preview: output.token || null,
      login_response: output.loginResponse || null,
      invite_response: output.inviteResponse || null,
      device_used: device,
      proxies_used: output.proxies_used || []
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const config = loadApiConfig();
    const phone = String(req.body.phone || '').trim();
    const code = String(req.body.code || '').trim();
    if (!phone || !code) {
      return res.status(400).json({ ok: false, error: '手机号和验证码不能为空' });
    }

    const appVersion = String(req.body.appVersion || '1.2.0').trim();
    const device = generateRandomDevice(appVersion);
    const vars = { phone, code, device, device_json: JSON.stringify(device) };

    const loginHeaders = renderTemplate(config.login.headers || {}, vars);
    const loginBody = renderTemplate(config.login.body_template || {}, vars);
    if (!Object.keys(loginHeaders).some((h) => h.toLowerCase() === 'content-type')) {
      loginHeaders['Content-Type'] = 'application/json';
    }

    const loginResp = await requestJson(config.login.url, {
      method: (config.login.method || 'POST').toUpperCase(),
      headers: loginHeaders,
      body: JSON.stringify(loginBody)
    });

    if (loginResp.body === null || typeof loginResp.body !== 'object' || Array.isArray(loginResp.body)) {
      return res.json({ ok: false, error: `登录响应非JSON (status ${loginResp.status})` });
    }

    const token = getByPath(loginResp.body, config.login.token_path);
    if (!token) {
      return res.json({ ok: false, error: `找不到token: ${config.login.token_path}`, response: loginResp.body });
    }

    return res.json({
      ok: true, token, phone,
      login_response: loginResp.body,
      proxy_used: loginResp.proxy_used
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/invite', async (req, res) => {
  try {
    const config = loadApiConfig();
    const token = String(req.body.token || '').trim();
    const inviteCode = String(req.body.inviteCode || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'token不能为空' });
    if (!inviteCode) return res.status(400).json({ ok: false, error: '邀请码不能为空' });

    const vars = { token, invite_code: inviteCode };
    const inviteHeaders = renderTemplate(config.invite.headers || {}, vars);
    const inviteBody = renderTemplate(config.invite.body_template || {}, vars);

    if (config.invite.token && config.invite.token.placement === 'header') {
      inviteHeaders[config.invite.token.key || 'Authorization'] = renderTemplate(
        config.invite.token.template || 'Bearer {{token}}', vars
      );
    }
    if (!Object.keys(inviteHeaders).some((h) => h.toLowerCase() === 'content-type')) {
      inviteHeaders['Content-Type'] = 'application/json';
    }

    const inviteResp = await requestJson(config.invite.url, {
      method: (config.invite.method || 'POST').toUpperCase(),
      headers: inviteHeaders,
      body: JSON.stringify(inviteBody)
    });

    let success = true;
    if (config.invite.success_rule) {
      if (inviteResp.body && typeof inviteResp.body === 'object') {
        success = evaluateSuccessRule(inviteResp.body, config.invite.success_rule);
      } else {
        success = false;
      }
    } else if (!inviteResp.ok) {
      success = false;
    }

    return res.json({
      ok: true, success,
      invite_response: inviteResp.body,
      proxy_used: inviteResp.proxy_used
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ── 好主码配置 ──

app.get('/api/haozhuma-config', (_, res) => {
  try {
    const hzm = getHzmConfig();
    res.json({ ok: true, haozhuma: { server: hzm.server || '', user: hzm.user || '', pass: hzm.pass || '', sid: hzm.sid || '', hasToken: Boolean(hzm.token) } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/haozhuma-config', (req, res) => {
  try {
    const { server, user, pass, sid } = req.body;
    const config = loadApiConfig();
    if (!config.haozhuma) config.haozhuma = {};
    if (server !== undefined) config.haozhuma.server = server.trim();
    if (user !== undefined) config.haozhuma.user = user.trim();
    if (pass !== undefined) config.haozhuma.pass = pass.trim();
    if (sid !== undefined) config.haozhuma.sid = sid.trim();
    saveApiConfig(config);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/haozhuma-login', async (req, res) => {
  try {
    const hzm = getHzmConfig();
    const server = hzm.server || 'https://api.haozhuma.com';
    if (!hzm.user || !hzm.pass) {
      return res.status(400).json({ ok: false, error: '请先配置好主码账号密码' });
    }
    const token = await hzmLogin(server, hzm.user, hzm.pass);
    saveHzmToken(token);
    res.json({ ok: true, token });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/haozhuma-balance', async (_, res) => {
  try {
    const hzm = getHzmConfig();
    const server = hzm.server || 'https://api.haozhuma.com';
    if (!hzm.token) {
      return res.status(400).json({ ok: false, error: '请先登录好主码' });
    }
    const data = await hzmRequest(server, { api: 'getSummary', token: hzm.token });
    if (String(data.code) !== '0') {
      throw new Error(data.msg || JSON.stringify(data));
    }
    res.json({ ok: true, money: data.money, num: data.num });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ── 自动执行（好主码全自动流程，SSE 流式推送） ──

app.get('/api/auto-run', async (req, res) => {
  const inviteCode = String(req.query.inviteCode || '').trim();
  const appVersion = String(req.query.appVersion || '1.2.0').trim();
  const count = parseInt(req.query.count, 10) || 1;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  if (!inviteCode) { send('error', { error: '邀请码不能为空' }); res.end(); return; }

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const hzm = getHzmConfig();
  const server = hzm.server || 'https://api.haozhuma.com';
  if (!hzm.token) { send('error', { error: '请先登录好主码' }); res.end(); return; }
  if (!hzm.sid) { send('error', { error: '请先配置好主码项目ID' }); res.end(); return; }

  const config = loadApiConfig();
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < count; i++) {
    if (cancelled) break;
    const step = { index: i + 1, phone: null, success: false, stage: null, reason: null, proxies: [] };

    send('progress', { current: i + 1, total: count, stage: 'getPhone', phone: null });

    try {
      step.stage = 'getPhone';
      const phone = await hzmGetPhone(server, hzm.token, hzm.sid);
      step.phone = phone;

      send('progress', { current: i + 1, total: count, stage: 'sendSms', phone });

      step.stage = 'sendSms';
      const smsUrl = `https://www.ankangme.com/prod-api/resource/sms/code?phone=${encodeURIComponent(phone)}`;
      let smsOk = false;
      for (let retry = 0; retry < 3; retry++) {
        try {
          const smsResp = await requestJson(smsUrl, { method: 'GET' });
          if (smsResp.ok) { smsOk = true; break; }
          step.reason = `发送验证码失败: HTTP ${smsResp.status}`;
        } catch (smsErr) {
          const detail = smsErr.cause ? smsErr.cause.message || smsErr.cause.code : smsErr.message;
          console.error(`[sendSms retry ${retry}] ${phone}:`, detail);
          step.reason = `发送验证码失败: ${detail}`;
        }
        if (retry < 2) await new Promise((r) => setTimeout(r, 3000));
      }
      if (!smsOk) {
        await hzmCancelRecv(server, hzm.token, hzm.sid, phone);
        failCount++;
        send('result', step);
        continue;
      }

      send('progress', { current: i + 1, total: count, stage: 'waitSms', phone });

      step.stage = 'waitSms';
      const smsCode = await hzmGetMessage(server, hzm.token, hzm.sid, phone, { isCancelled: () => cancelled });
      if (!smsCode) {
        step.reason = '等待验证码超时(3分钟)';
        await hzmAddBlacklist(server, hzm.token, hzm.sid, phone);
        failCount++;
        send('result', step);
        continue;
      }

      send('progress', { current: i + 1, total: count, stage: 'loginAndInvite', phone });

      step.stage = 'loginAndInvite';
      const device = generateRandomDevice(appVersion);
      const output = await runLoginAndInvite({ phone, code: smsCode, inviteCode, device }, config);

      step.success = output.success;
      step.stage = output.stage || 'invite';
      step.reason = output.success ? JSON.stringify(output.inviteResponse) : output.reason;
      step.proxies = output.proxies_used || [];

      await hzmCancelRecv(server, hzm.token, hzm.sid, phone);
    } catch (err) {
      step.reason = err.message;
      if (step.phone) await hzmCancelRecv(server, hzm.token, hzm.sid, step.phone);
    }

    if (step.success) successCount++; else failCount++;
    send('result', step);

    if (i < count - 1) await new Promise((r) => setTimeout(r, 2000));
  }

  send('done', { total: count, success: successCount, fail: failCount });
  res.end();
});

app.listen(PORT, () => {
  console.log(`Invite console is running on http://localhost:${PORT}`);
});
