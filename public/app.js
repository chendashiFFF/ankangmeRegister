const phoneEl = document.getElementById('phone');
const smsCodeEl = document.getElementById('smsCode');
const inviteCodeEl = document.getElementById('inviteCode');
const appVersionEl = document.getElementById('appVersion');
const smsBtn = document.getElementById('smsBtn');
const runBtn = document.getElementById('runBtn');
const statusBox = document.getElementById('statusBox');
const resultsBody = document.getElementById('resultsBody');

const totalEl = document.getElementById('total');
const successEl = document.getElementById('success');
const failEl = document.getElementById('fail');
const rateEl = document.getElementById('rate');

const proxyInfoEl = document.getElementById('proxyInfo');
const proxyModeEl = document.getElementById('proxyMode');
const customProxyUrlEl = document.getElementById('customProxyUrl');
const customProxyRowEl = document.getElementById('customProxyRow');
const proxySaveBtn = document.getElementById('proxySaveBtn');
const scrapeDoTokenEl = document.getElementById('scrapeDoToken');
const scrapeDoRowEl = document.getElementById('scrapeDoRow');

const hzmServerEl = document.getElementById('hzmServer');
const hzmUserEl = document.getElementById('hzmUser');
const hzmPassEl = document.getElementById('hzmPass');
const hzmSidEl = document.getElementById('hzmSid');
const hzmSaveBtn = document.getElementById('hzmSaveBtn');
const hzmLoginBtn = document.getElementById('hzmLoginBtn');
const hzmStatusEl = document.getElementById('hzmStatus');

const autoCountEl = document.getElementById('autoCount');
const autoRunBtn = document.getElementById('autoRunBtn');
const autoStopBtn = document.getElementById('autoStopBtn');
const autoStatusEl = document.getElementById('autoStatus');

const STORAGE_KEY = 'invite_console_data';

function loadStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { stats: { total: 0, success: 0, fail: 0 }, results: [] };
}

function saveStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ stats, results }));
}

let { stats, results } = loadStorage();

function setStatus(text, isError = false) {
  statusBox.textContent = text;
  statusBox.classList.toggle('error', Boolean(isError));
}

// ── 代理配置 ──

function toggleCustomRow() {
  customProxyRowEl.style.display = proxyModeEl.value === 'custom' ? 'block' : 'none';
  scrapeDoRowEl.style.display = proxyModeEl.value === 'scrape_do' ? 'block' : 'none';
}

async function loadProxyStatus() {
  try {
    const resp = await fetch('/api/proxy-status');
    const data = await resp.json();
    if (!data.ok) { proxyInfoEl.textContent = '代理状态获取失败'; return; }
    if (data.mode === 'custom') {
      proxyInfoEl.textContent = `当前：自定义代理 (${data.custom_url || '未设置'})`;
    } else if (data.mode === 'scrape_do') {
      proxyInfoEl.textContent = `当前：Scrape.do ${data.has_token ? '已配置' : '未配置Token'}`;
    } else {
      proxyInfoEl.textContent = '当前：直连模式（不使用代理）';
    }
  } catch {
    proxyInfoEl.textContent = '代理状态未知';
  }
}

async function saveProxyConfig() {
  proxySaveBtn.disabled = true;
  try {
    const resp = await fetch('/api/proxy-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: proxyModeEl.value, custom_url: customProxyUrlEl.value.trim(), scrape_do_token: scrapeDoTokenEl.value.trim() })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    setStatus('代理设置已保存');
    await loadProxyStatus();
  } catch (err) {
    setStatus(`保存失败: ${err.message}`, true);
  } finally {
    proxySaveBtn.disabled = false;
  }
}

async function loadProxyConfig() {
  try {
    const resp = await fetch('/api/proxy-config');
    const data = await resp.json();
    if (data.ok && data.proxy) {
      proxyModeEl.value = data.proxy.mode || 'direct';
      customProxyUrlEl.value = data.proxy.custom_url || '';
      scrapeDoTokenEl.value = data.proxy.scrape_do_token || '';
      toggleCustomRow();
    }
  } catch {}
  await loadProxyStatus();
}

proxyModeEl.addEventListener('change', () => { toggleCustomRow(); saveProxyConfig(); });
proxySaveBtn.addEventListener('click', saveProxyConfig);
loadProxyConfig();

// ── 好主码配置 ──

async function loadHzmConfig() {
  try {
    const resp = await fetch('/api/haozhuma-config');
    const data = await resp.json();
    if (data.ok && data.haozhuma) {
      hzmServerEl.value = data.haozhuma.server || 'https://api.haozhuma.com';
      hzmUserEl.value = data.haozhuma.user || '';
      hzmPassEl.value = data.haozhuma.pass || '';
      hzmSidEl.value = data.haozhuma.sid || '';
      hzmStatusEl.textContent = data.haozhuma.hasToken ? '已登录' : '未登录';
    }
  } catch {}
}

async function saveHzmConfig() {
  hzmSaveBtn.disabled = true;
  try {
    const resp = await fetch('/api/haozhuma-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: hzmServerEl.value.trim(),
        user: hzmUserEl.value.trim(),
        pass: hzmPassEl.value.trim(),
        sid: hzmSidEl.value.trim()
      })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    hzmStatusEl.textContent = '配置已保存';
  } catch (err) {
    hzmStatusEl.textContent = `保存失败: ${err.message}`;
  } finally {
    hzmSaveBtn.disabled = false;
  }
}

async function hzmLogin() {
  hzmLoginBtn.disabled = true;
  hzmStatusEl.textContent = '登录中...';
  try {
    await saveHzmConfig();
    const resp = await fetch('/api/haozhuma-login', { method: 'POST' });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    hzmStatusEl.textContent = '登录成功';
  } catch (err) {
    hzmStatusEl.textContent = `登录失败: ${err.message}`;
  } finally {
    hzmLoginBtn.disabled = false;
  }
}

hzmSaveBtn.addEventListener('click', saveHzmConfig);
hzmLoginBtn.addEventListener('click', hzmLogin);
loadHzmConfig();

// ── 统计与结果 ──

function updateStats() {
  totalEl.textContent = stats.total;
  successEl.textContent = stats.success;
  failEl.textContent = stats.fail;
  rateEl.textContent = stats.total
    ? ((stats.success / stats.total) * 100).toFixed(1) + '%'
    : '0%';
}

function addResult(row) {
  const tr = document.createElement('tr');
  const proxy = row.proxies ? row.proxies.join(', ') : '-';
  tr.innerHTML = `
    <td>${row.index}</td>
    <td>${row.phone}</td>
    <td class="${row.success ? 'ok' : 'bad'}">${row.success ? '成功' : '失败'}</td>
    <td>${proxy}</td>
    <td>${row.stage || '-'}</td>
    <td>${row.reason || '-'}</td>
  `;
  resultsBody.appendChild(tr);
}

function renderAllResults() {
  resultsBody.innerHTML = '';
  for (const row of results) addResult(row);
  updateStats();
}

renderAllResults();

// ── 发送验证码 ──

async function sendSms() {
  const phone = phoneEl.value.trim();
  if (!phone) { setStatus('请输入手机号', true); return; }

  smsBtn.disabled = true;
  setStatus('发送验证码中...');

  try {
    const resp = await fetch(`/api/send-sms?phone=${encodeURIComponent(phone)}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    setStatus(`验证码已发送到 ${phone}`);
    smsCodeEl.focus();
  } catch (error) {
    setStatus(`发送失败: ${error.message}`, true);
  } finally {
    smsBtn.disabled = false;
  }
}

// ── 登录并填码 ──

async function run() {
  const inviteCode = inviteCodeEl.value.trim();
  const phone = phoneEl.value.trim();
  const code = smsCodeEl.value.trim();
  const appVersion = appVersionEl.value.trim() || '1.2.0';

  if (!inviteCode) { setStatus('请输入邀请码', true); return; }
  if (!phone) { setStatus('请输入手机号', true); return; }
  if (!code) { setStatus('请输入验证码', true); return; }

  runBtn.disabled = true;
  setStatus('登录并填码中...');

  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteCode, phone, code, appVersion })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    stats.total++;
    if (data.success) { stats.success++; } else { stats.fail++; }
    updateStats();

    const detail = data.invite_response ? JSON.stringify(data.invite_response) : '-';
    const row = {
      index: stats.total,
      phone: data.phone,
      success: data.success,
      stage: data.stage || 'invite',
      reason: data.success ? detail : (data.reason || detail),
      proxies: data.proxies_used || []
    };
    results.push(row);
    addResult(row);
    saveStorage();

    setStatus(data.success
      ? `${phone} 成功\n接口返回: ${detail}`
      : `${phone} 失败 [${data.stage}]: ${data.reason}`);
    smsCodeEl.value = '';
    phoneEl.value = '';
    phoneEl.focus();
  } catch (error) {
    setStatus(`执行失败: ${error.message}`, true);
  } finally {
    runBtn.disabled = false;
  }
}

// ── 自动执行 ──

function setAutoStatus(text, isError = false) {
  autoStatusEl.textContent = text;
  autoStatusEl.classList.toggle('error', Boolean(isError));
}

let currentEs = null;

function stopAutoRun() {
  if (currentEs) {
    currentEs.close();
    currentEs = null;
  }
  setAutoStatus('已停止');
  autoRunBtn.disabled = false;
  autoStopBtn.style.display = 'none';
}

function autoRun() {
  const inviteCode = inviteCodeEl.value.trim();
  const appVersion = appVersionEl.value.trim() || '1.2.0';
  const count = parseInt(autoCountEl.value, 10) || 1;

  if (!inviteCode) { setAutoStatus('请输入邀请码', true); return; }

  autoRunBtn.disabled = true;
  autoStopBtn.style.display = '';
  setAutoStatus(`开始自动执行 0/${count}...`);

  const params = new URLSearchParams({ inviteCode, appVersion, count });
  const es = new EventSource(`/api/auto-run?${params}`);
  currentEs = es;

  function finish() {
    es.close();
    currentEs = null;
    autoRunBtn.disabled = false;
    autoStopBtn.style.display = 'none';
  }

  es.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    const stageMap = { getPhone: '取号', sendSms: '发短信', waitSms: '等验证码', loginAndInvite: '登录填码' };
    setAutoStatus(`${d.current}/${d.total} ${stageMap[d.stage] || d.stage} ${d.phone || ''}`);
  });

  es.addEventListener('result', (e) => {
    const r = JSON.parse(e.data);
    stats.total++;
    if (r.success) { stats.success++; } else { stats.fail++; }
    const row = {
      index: stats.total,
      phone: r.phone || '-',
      success: r.success,
      stage: r.stage || '-',
      reason: r.reason || '-',
      proxies: r.proxies || []
    };
    results.push(row);
    addResult(row);
    updateStats();
    saveStorage();
  });

  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    setAutoStatus(`完成: ${d.success}/${d.total} 成功, ${d.fail} 失败`);
    finish();
  });

  es.addEventListener('error', (e) => {
    try {
      const d = JSON.parse(e.data);
      setAutoStatus(`自动执行失败: ${d.error}`, true);
    } catch {
      setAutoStatus('连接中断', true);
    }
    finish();
  });
}

// ── 事件绑定 ──

smsBtn.addEventListener('click', sendSms);
runBtn.addEventListener('click', run);
autoRunBtn.addEventListener('click', autoRun);
autoStopBtn.addEventListener('click', stopAutoRun);

document.getElementById('clearBtn').addEventListener('click', () => {
  stats = { total: 0, success: 0, fail: 0 };
  results = [];
  saveStorage();
  renderAllResults();
  setStatus('记录已清空');
});
