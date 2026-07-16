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
  currentIndex: -1, // index into chapters headers
  chapterDetail: null,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { useProxy: true, apiBase: '', ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return {
    apiBase: '',
    useProxy: true,
  };
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function $(id) {
  return document.getElementById(id);
}

function toast(msg, ms = 2600) {
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

function showView(name) {
  for (const id of ['view-home', 'view-album', 'view-reader']) {
    $(id).hidden = id !== `view-${name}`;
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

function proxyImageUrl(originalUrl) {
  if (!state.settings.useProxy) return originalUrl;
  const base = apiBase();
  if (!base) return originalUrl;
  return `${base}/proxy?url=${encodeURIComponent(originalUrl)}`;
}

/**
 * Decode JM row-scramble image onto a canvas.
 * Algorithm mirrors ScrambleDecoder::decodeFile in the PHP project.
 */
async function decodeToCanvas(imgUrl, segments) {
  const src = proxyImageUrl(imgUrl);
  const res = await fetch(src, { mode: 'cors' });
  if (!res.ok) throw new Error(`图片 HTTP ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
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
  } finally {
    setLoading(false);
  }
}

function renderAlbum() {
  const a = state.album;
  $('album-title').textContent = a.name || `JM${a.album_id}`;
  $('brand').textContent = a.name || 'JM Reader';
  $('album-authors').textContent = (a.author || []).join(' / ') || '未知作者';
  $('album-desc').textContent = a.description || '';
  $('album-stats').textContent =
    `ID ${a.album_id} · 浏览 ${a.total_views} · 喜欢 ${a.likes} · ${a.chapters} 话`;

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
  $('brand').textContent = ch.title || state.album?.name || '阅读';

  const prevDisabled = state.currentIndex <= 0;
  const nextDisabled =
    state.currentIndex < 0 || state.currentIndex >= state.chapters.length - 1;
  $('btn-prev-ch').disabled = prevDisabled;
  $('btn-next-ch').disabled = nextDisabled;
  $('btn-next-ch-2').disabled = nextDisabled;

  const root = $('reader-pages');
  root.innerHTML = '';

  // Progressive render
  for (const img of ch.images || []) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `${img.index} / ${ch.page_count}`;
    wrap.appendChild(label);

    const placeholder = document.createElement('div');
    placeholder.className = 'page-error';
    placeholder.style.color = 'var(--muted)';
    placeholder.textContent = '加载中…';
    wrap.appendChild(placeholder);
    root.appendChild(wrap);

    // Yield to paint
    await new Promise((r) => requestAnimationFrame(r));

    try {
      const canvas = await decodeToCanvas(img.url, img.decode_segments);
      placeholder.remove();
      wrap.appendChild(canvas);
    } catch (e) {
      placeholder.textContent = `第 ${img.index} 页失败：${e.message}`;
      placeholder.style.color = 'var(--danger)';
    }
  }
}

function goAdjacentChapter(delta) {
  const next = state.currentIndex + delta;
  if (next < 0 || next >= state.chapters.length) return;
  loadChapter(state.chapters[next].photo_id).catch((e) => toast(e.message));
}

function openSettings(force = false) {
  $('api-base').value = state.settings.apiBase || '';
  $('use-proxy').checked = state.settings.useProxy !== false;
  $('settings-modal').hidden = false;
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
    loadAlbum(q).catch((err) => {
      const el = $('home-error');
      el.textContent = err.message;
      el.hidden = false;
      toast(err.message);
    });
  });

  $('btn-home').addEventListener('click', () => {
    showView('home');
    $('brand').textContent = 'JM Reader';
    history.replaceState({ view: 'home' }, '', '#/');
  });

  $('btn-settings').addEventListener('click', () => openSettings());
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', () => {
    state.settings.apiBase = $('api-base').value.trim();
    state.settings.useProxy = $('use-proxy').checked;
    saveSettings();
    closeSettings();
    toast('设置已保存');
  });

  $('btn-back-album').addEventListener('click', () => {
    if (state.album) {
      renderAlbum();
      showView('album');
      history.replaceState(
        { view: 'album', jmid: state.album.album_id },
        '',
        `#/album/${state.album.album_id}`,
      );
    } else showView('home');
  });

  $('btn-prev-ch').addEventListener('click', () => goAdjacentChapter(-1));
  $('btn-next-ch').addEventListener('click', () => goAdjacentChapter(1));
  $('btn-next-ch-2').addEventListener('click', () => goAdjacentChapter(1));

  // Age gate
  const ageOk = localStorage.getItem(AGE_KEY) === '1';
  if (!ageOk) {
    $('age-gate').hidden = false;
  }
  $('age-enter').addEventListener('click', () => {
    localStorage.setItem(AGE_KEY, '1');
    $('age-gate').hidden = true;
  });
  $('age-leave').addEventListener('click', () => {
    location.href = 'about:blank';
  });

  // Hash routing (basic)
  window.addEventListener('hashchange', () => routeFromHash().catch(() => {}));
}

async function routeFromHash() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const albumMatch = hash.match(/^\/album\/(\d+)(?:\/ch\/(\d+))?$/);
  if (!albumMatch) {
    showView('home');
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
  // Prefill settings field if empty and ?api= present
  const params = new URLSearchParams(location.search);
  const api = params.get('api');
  if (api && !state.settings.apiBase) {
    state.settings.apiBase = api;
    saveSettings();
  }
  routeFromHash().catch((e) => toast(e.message));
}

main();
