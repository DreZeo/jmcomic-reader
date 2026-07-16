/**
 * JM Reader — static frontend for GitHub Pages
 * Talks to Cloudflare Worker API (ported from jmcomic-api PHP).
 */

const STORAGE_KEY = 'jm-reader-settings';
const AGE_KEY = 'jm-reader-age-ok';

const state = {
  settings: loadSettings(),
  album: null,
  chapters: [],
  currentIndex: -1,
  chapterDetail: null,
  chromeTimer: null,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { useProxy: true, apiBase: '', ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { apiBase: '', useProxy: true };
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function $(id) {
  return document.getElementById(id);
}

function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function setLoading(on, text = '加载中…') {
  const el = $('loading');
  $('loading-text').textContent = text;
  el.hidden = !on;
}

function setBrand(title, isHome = false) {
  const brand = $('brand');
  if (isHome) {
    brand.innerHTML =
      '<span class="brand-mark" aria-hidden="true">JM</span><span class="brand-text">Reader</span>';
    return;
  }
  brand.innerHTML = '';
  const mark = document.createElement('span');
  mark.className = 'brand-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = 'JM';
  const text = document.createElement('span');
  text.className = 'brand-text';
  text.textContent = title || 'Reader';
  brand.append(mark, text);
}

function showView(name) {
  for (const id of ['view-home', 'view-album', 'view-reader']) {
    $(id).hidden = id !== `view-${name}`;
  }
  document.body.classList.toggle('reader-active', name === 'reader');
  if (name === 'reader') {
    showChrome(true);
  } else {
    document.body.classList.remove('chrome-visible');
  }
}

function showChrome(autoHide = true) {
  document.body.classList.add('chrome-visible');
  clearTimeout(state.chromeTimer);
  if (autoHide) {
    state.chromeTimer = setTimeout(() => {
      document.body.classList.remove('chrome-visible');
    }, 2800);
  }
}

function apiBase() {
  return (state.settings.apiBase || '').replace(/\/+$/, '');
}

function requireApi() {
  const base = apiBase();
  if (!base) {
    openSettings(true);
    throw new Error('请先在设置中填写 API 地址');
  }
  return base;
}

async function apiGet(query) {
  const base = requireApi();
  const url = `${base}/?${query}`;
  const res = await fetch(url, { method: 'GET' });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`API 返回非 JSON (HTTP ${res.status})`);
  }
  if (!res.ok || !json.success) {
    throw new Error(json.error || `请求失败 HTTP ${res.status}`);
  }
  return json.data;
}

const CDN_HOSTS = [
  'cdn-msp.jmapiproxy1.cc',
  'cdn-msp.jmapiproxy2.cc',
  'cdn-msp2.jmapiproxy2.cc',
  'cdn-msp3.jmapiproxy2.cc',
  'cdn-msp.jmapinodeudzn.net',
  'cdn-msp3.jmapinodeudzn.net',
];

function proxyImageUrl(originalUrl) {
  if (!state.settings.useProxy) return originalUrl;
  const base = apiBase();
  if (!base) return originalUrl;
  return `${base}/proxy?url=${encodeURIComponent(originalUrl)}`;
}

function imageCandidateUrls(originalUrl) {
  try {
    const u = new URL(originalUrl);
    const path = u.pathname + u.search;
    const hosts = [u.hostname, ...CDN_HOSTS.filter((h) => h !== u.hostname)];
    return hosts.map((h) => `https://${h}${path}`);
  } catch {
    return [originalUrl];
  }
}

async function fetchImageBlob(imgUrl) {
  const errors = [];

  if (state.settings.useProxy) {
    for (const candidate of imageCandidateUrls(imgUrl)) {
      const src = proxyImageUrl(candidate);
      try {
        const res = await fetch(src, { mode: 'cors' });
        if (!res.ok) {
          let detail = '';
          try {
            const j = await res.clone().json();
            detail = j.detail || j.error || '';
          } catch {
            /* ignore */
          }
          errors.push(`${new URL(candidate).hostname}:${res.status}${detail ? `(${detail})` : ''}`);
          continue;
        }
        const blob = await res.blob();
        if (!blob || blob.size < 32) {
          errors.push(`${new URL(candidate).hostname}:empty`);
          continue;
        }
        return blob;
      } catch {
        errors.push(`${new URL(candidate).hostname}:net`);
      }
    }
  }

  try {
    const res = await fetch(imgUrl, { mode: 'cors' });
    if (res.ok) return await res.blob();
    errors.push(`direct:${res.status}`);
  } catch {
    errors.push('direct:cors');
  }

  throw new Error(`图片加载失败 ${errors.slice(0, 3).join(' | ')}`);
}

/**
 * Decode JM row-scramble image onto a canvas.
 * Algorithm mirrors ScrambleDecoder / JmImageTool.decode_and_save.
 */
async function decodeToCanvas(imgUrl, segments) {
  const blob = await fetchImageBlob(imgUrl);
  const bitmap = await createImageBitmap(blob);

  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '漫画页面');
  const ctx = canvas.getContext('2d');

  if (!segments || segments <= 0) {
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return canvas;
  }

  const over = h % segments;
  for (let i = 0; i < segments; i++) {
    let move = Math.floor(h / segments);
    let ySrc = h - move * (i + 1) - over;
    let yDst = move * i;
    if (i === 0) {
      move += over;
    } else {
      yDst += over;
    }
    ctx.drawImage(bitmap, 0, ySrc, w, move, 0, yDst, w, move);
  }
  bitmap.close?.();
  return canvas;
}

function formatCount(n) {
  const x = Number(String(n).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(x)) return String(n ?? '0');
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e4) return `${(x / 1e4).toFixed(1)}万`;
  return String(Math.round(x));
}

async function loadAlbum(jmidRaw) {
  setLoading(true, '拉取专辑…');
  try {
    const data = await apiGet(`jmid=${encodeURIComponent(jmidRaw)}&format=min`);
    state.album = data.album;
    state.chapters = data.chapters || [];
    renderAlbum();
    showView('album');
    history.replaceState(
      { view: 'album', jmid: data.album.album_id },
      '',
      `#/album/${data.album.album_id}`,
    );
  } finally {
    setLoading(false);
  }
}

async function loadChapter(photoId) {
  if (!state.album) throw new Error('无专辑上下文');
  setLoading(true, '拉取章节图片…');
  try {
    const data = await apiGet(
      `jmid=${encodeURIComponent(state.album.album_id)}&chapter=${encodeURIComponent(photoId)}&format=min`,
    );
    const ch = data.chapters?.[0];
    if (!ch) throw new Error('章节无数据');
    state.chapterDetail = ch;
    state.currentIndex = state.chapters.findIndex((c) => c.photo_id === photoId);
    await renderReader();
    showView('reader');
    history.replaceState(
      { view: 'reader', jmid: state.album.album_id, photoId },
      '',
      `#/album/${state.album.album_id}/ch/${photoId}`,
    );
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  } finally {
    setLoading(false);
  }
}

function renderAlbum() {
  const a = state.album;
  $('album-title').textContent = a.name || `JM${a.album_id}`;
  $('album-id-label').textContent = `专辑 · ${a.album_id}`;
  setBrand(a.name || `JM${a.album_id}`);
  $('album-authors').textContent = (a.author || []).join(' / ') || '未知作者';
  $('album-desc').textContent = a.description || '暂无简介';

  const stats = $('album-stats');
  stats.innerHTML = '';
  const chips = [
    ['浏览', formatCount(a.total_views)],
    ['喜欢', formatCount(a.likes)],
    ['评论', formatCount(a.comments)],
    ['话数', String(a.chapters ?? state.chapters.length)],
  ];
  for (const [label, value] of chips) {
    const el = document.createElement('span');
    el.className = 'stat-chip';
    el.textContent = `${label} ${value}`;
    stats.appendChild(el);
  }

  const tags = $('album-tags');
  tags.innerHTML = '';
  for (const t of a.tags || []) {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = t;
    tags.appendChild(span);
  }

  $('chapter-count').textContent = `共 ${state.chapters.length} 话`;
  const list = $('chapter-list');
  list.innerHTML = '';
  state.chapters.forEach((ch, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chapter-item';
    btn.innerHTML = `<span class="sort">#${ch.sort || i + 1}</span><span class="title"></span>`;
    btn.querySelector('.title').textContent = ch.title || ch.photo_id;
    btn.addEventListener('click', () => {
      loadChapter(ch.photo_id).catch((e) => toast(e.message));
    });
    list.appendChild(btn);
  });
}

async function renderReader() {
  const ch = state.chapterDetail;
  $('reader-title').textContent = ch.title || ch.photo_id;
  $('reader-progress').textContent =
    state.currentIndex >= 0
      ? `第 ${state.currentIndex + 1} / ${state.chapters.length} 话 · ${ch.page_count} 页`
      : `${ch.page_count} 页`;
  setBrand(ch.title || state.album?.name || '阅读');

  const prevDisabled = state.currentIndex <= 0;
  const nextDisabled =
    state.currentIndex < 0 || state.currentIndex >= state.chapters.length - 1;
  $('btn-prev-ch').disabled = prevDisabled;
  $('btn-next-ch').disabled = nextDisabled;
  $('btn-next-ch-2').disabled = nextDisabled;

  const root = $('reader-pages');
  root.innerHTML = '';

  for (const img of ch.images || []) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.index = String(img.index);

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `${img.index} / ${ch.page_count}`;
    wrap.appendChild(label);

    const placeholder = document.createElement('div');
    placeholder.className = 'page-placeholder';
    placeholder.textContent = '加载中…';
    wrap.appendChild(placeholder);
    root.appendChild(wrap);

    await new Promise((r) => requestAnimationFrame(r));

    try {
      const canvas = await decodeToCanvas(img.url, img.decode_segments);
      placeholder.remove();
      wrap.appendChild(canvas);
    } catch (e) {
      placeholder.className = 'page-error';
      placeholder.textContent = `第 ${img.index} 页失败：${e.message}`;
    }
  }
}

function goAdjacentChapter(delta) {
  const next = state.currentIndex + delta;
  if (next < 0 || next >= state.chapters.length) return;
  loadChapter(state.chapters[next].photo_id).catch((e) => toast(e.message));
}

function backToAlbum() {
  if (state.album) {
    renderAlbum();
    showView('album');
    history.replaceState(
      { view: 'album', jmid: state.album.album_id },
      '',
      `#/album/${state.album.album_id}`,
    );
  } else {
    showView('home');
    setBrand('', true);
  }
}

function openSettings(force = false) {
  $('api-base').value = state.settings.apiBase || '';
  $('use-proxy').checked = state.settings.useProxy !== false;
  $('settings-modal').hidden = false;
  setTimeout(() => $('api-base').focus(), 50);
  if (force) toast('请先配置 Worker API 地址');
}

function closeSettings() {
  $('settings-modal').hidden = true;
}

function bindUi() {
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('search-input').value.trim();
    $('home-error').hidden = true;
    const btn = $('btn-search');
    btn.disabled = true;
    loadAlbum(q)
      .catch((err) => {
        const el = $('home-error');
        el.textContent = err.message;
        el.hidden = false;
        toast(err.message);
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  $('btn-home').addEventListener('click', () => {
    showView('home');
    setBrand('', true);
    history.replaceState({ view: 'home' }, '', '#/');
  });

  $('btn-album-back')?.addEventListener('click', () => {
    showView('home');
    setBrand('', true);
    history.replaceState({ view: 'home' }, '', '#/');
  });

  $('btn-settings').addEventListener('click', () => openSettings());
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-close')?.addEventListener('click', closeSettings);
  $('settings-modal').addEventListener('click', (e) => {
    if (e.target === $('settings-modal')) closeSettings();
  });
  $('settings-save').addEventListener('click', () => {
    state.settings.apiBase = $('api-base').value.trim();
    state.settings.useProxy = $('use-proxy').checked;
    saveSettings();
    closeSettings();
    toast('设置已保存');
  });

  $('btn-back-album').addEventListener('click', backToAlbum);
  $('btn-back-album-2')?.addEventListener('click', backToAlbum);
  $('btn-prev-ch').addEventListener('click', () => goAdjacentChapter(-1));
  $('btn-next-ch').addEventListener('click', () => goAdjacentChapter(1));
  $('btn-next-ch-2').addEventListener('click', () => goAdjacentChapter(1));

  // Tap page area to toggle chrome in reader
  $('reader-pages').addEventListener('click', () => {
    if (!document.body.classList.contains('reader-active')) return;
    if (document.body.classList.contains('chrome-visible')) {
      document.body.classList.remove('chrome-visible');
      clearTimeout(state.chromeTimer);
    } else {
      showChrome(true);
    }
  });

  // Age gate
  const ageOk = localStorage.getItem(AGE_KEY) === '1';
  if (!ageOk) $('age-gate').hidden = false;
  $('age-enter').addEventListener('click', () => {
    localStorage.setItem(AGE_KEY, '1');
    $('age-gate').hidden = true;
  });
  $('age-leave').addEventListener('click', () => {
    location.href = 'about:blank';
  });

  // Escape closes settings
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings-modal').hidden) closeSettings();
  });

  window.addEventListener('hashchange', () => routeFromHash().catch(() => {}));
}

async function routeFromHash() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const albumMatch = hash.match(/^\/album\/(\d+)(?:\/ch\/(\d+))?$/);
  if (!albumMatch) {
    showView('home');
    setBrand('', true);
    return;
  }
  const jmid = albumMatch[1];
  const photoId = albumMatch[2];
  if (!state.album || state.album.album_id !== jmid) {
    await loadAlbum(jmid);
  }
  if (photoId) {
    await loadChapter(photoId);
  }
}

function main() {
  bindUi();
  const params = new URLSearchParams(location.search);
  const api = params.get('api');
  if (api && !state.settings.apiBase) {
    state.settings.apiBase = api;
    saveSettings();
  }
  // Default API if empty (optional convenience for this deployment)
  if (!state.settings.apiBase) {
    // leave empty — user configures; prefilled via ?api= still works
  }
  routeFromHash().catch((e) => toast(e.message));
}

main();
