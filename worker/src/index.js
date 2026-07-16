/**
 * JM Comic API — Cloudflare Worker
 * Port of https://github.com/ccbkkb/jmcomic-api (PHP) for edge deployment.
 *
 * Routes:
 *   GET /?jmid=ID
 *   GET /?jmid=ID&chapter=PID|all|@N|id1,id2
 *   GET /?jmid=ID&format=min
 *   GET /?health=1
 *   GET /proxy?url=https://cdn.../media/photos/...  (image proxy for canvas)
 *   OPTIONS *  (CORS preflight)
 */

import { ENDPOINT_ALBUM, ENDPOINT_CHAPTER, MAX_CHAPTERS, UA } from './config.js';
import { JmClient } from './jm-client.js';
import { parseAlbum, parseChapter, parseJmId, resolveChapterIds } from './models.js';

const ALLOWED_CDN_HOSTS = new Set([
  'cdn-msp.jmapiproxy1.cc',
  'cdn-msp.jmapiproxy2.cc',
  'cdn-msp2.jmapiproxy2.cc',
  'cdn-msp3.jmapiproxy2.cc',
  'cdn-msp.jmapinodeudzn.net',
  'cdn-msp3.jmapinodeudzn.net',
]);

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').trim();
  const origin = request.headers.get('Origin') || '';
  let allowOrigin = '*';

  if (allowed !== '*') {
    const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && list.includes(origin)) allowOrigin = origin;
    else if (list.length) allowOrigin = list[0];
    else allowOrigin = 'null';
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

function jsonResponse(data, status, request, env, minify = false) {
  const body = JSON.stringify(
    data,
    null,
    minify ? 0 : 2,
  );
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
      ...securityHeaders(),
      ...(status === 429
        ? { 'Retry-After': String(data.retry_after ?? 60) }
        : {}),
    },
  });
}

function errorJson(status, msg, request, env, extra = {}) {
  const safe = status >= 500 ? '服务器内部错误' : msg;
  return jsonResponse(
    { code: status, success: false, error: safe, ...extra },
    status,
    request,
    env,
  );
}

/** Best-effort in-isolate rate limit (not global). */
const rateBuckets = new Map();

function checkRate(ip, maxPerMin) {
  const now = Date.now();
  const windowMs = 60_000;
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  // Cap map size
  if (rateBuckets.size > 5000) {
    const first = rateBuckets.keys().next().value;
    rateBuckets.delete(first);
  }
  return bucket.count <= maxPerMin;
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

function isAllowedProxyUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (!ALLOWED_CDN_HOSTS.has(u.hostname)) return false;
  // Only photo media paths: /media/photos/{id}/{file}
  if (!/^\/media\/photos\/\d+\/[^/]+$/.test(u.pathname)) return false;
  return true;
}

/** Isolate memory: remember last CDN host that worked for photo proxy. */
let preferredProxyHost = null;

/** Same path on known CDN hosts — preferred host first, then request host, then rest. */
function proxyCandidateUrls(primary) {
  const u = new URL(primary);
  const rest = [...ALLOWED_CDN_HOSTS].filter(
    (h) => h !== u.hostname && h !== preferredProxyHost,
  );
  const hosts = [];
  if (preferredProxyHost && ALLOWED_CDN_HOSTS.has(preferredProxyHost)) {
    hosts.push(preferredProxyHost);
  }
  if (!preferredProxyHost || preferredProxyHost !== u.hostname) {
    hosts.push(u.hostname);
  }
  hosts.push(...rest);
  const seen = new Set();
  return hosts
    .filter((h) => {
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    })
    .map((h) => `https://${h}${u.pathname}${u.search}`);
}

function isImageishResponse(res) {
  if (!res.ok) return false;
  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  if (!ct) return true;
  return ct.startsWith('image/') || ct.includes('octet-stream') || ct.includes('webp');
}

async function fetchUpstreamImage(targetUrl, signal) {
  const headers = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://18comic.vip/',
    Origin: 'https://18comic.vip',
  };

  let res = await fetch(targetUrl, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal,
  });

  // Retry once without Origin if blocked
  if (res.status === 403 || res.status === 401) {
    res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'image/webp,image/*,*/*',
        Referer: 'https://18comic.vip/',
      },
      redirect: 'follow',
      signal,
    });
  }

  return res;
}

/**
 * Race the first N CDN candidates; first valid image wins.
 * Remaining hosts are tried serially only if the race all fail.
 */
async function fetchFirstGoodImage(candidates, raceCount = 2) {
  const attempts = [];
  const race = candidates.slice(0, Math.max(1, raceCount));
  const rest = candidates.slice(race.length);

  if (race.length === 1) {
    try {
      const res = await fetchUpstreamImage(race[0]);
      if (isImageishResponse(res)) {
        preferredProxyHost = new URL(race[0]).hostname;
        return { res, host: preferredProxyHost, attempts };
      }
      attempts.push(`${new URL(race[0]).hostname}:${res.status}`);
    } catch {
      attempts.push(`${new URL(race[0]).hostname}:err`);
    }
  } else {
    const controller = new AbortController();
    const tasks = race.map(async (candidate) => {
      const host = new URL(candidate).hostname;
      try {
        const res = await fetchUpstreamImage(candidate, controller.signal);
        if (!isImageishResponse(res)) {
          return { ok: false, host, detail: String(res.status) };
        }
        return { ok: true, host, res, candidate };
      } catch (e) {
        if (e?.name === 'AbortError') return { ok: false, host, detail: 'abort' };
        return { ok: false, host, detail: 'err' };
      }
    });

    // Settle until first success, then abort siblings
    const pending = new Set(tasks);
    let winner = null;
    while (pending.size && !winner) {
      const settled = await Promise.race(
        [...pending].map((p) => p.then((r) => ({ p, r }))),
      );
      pending.delete(settled.p);
      if (settled.r.ok) {
        winner = settled.r;
        controller.abort();
      } else {
        attempts.push(`${settled.r.host}:${settled.r.detail}`);
      }
    }
    // Drain losers (ignore)
    await Promise.allSettled([...pending]);
    if (winner) {
      preferredProxyHost = winner.host;
      return { res: winner.res, host: winner.host, attempts };
    }
  }

  for (const candidate of rest) {
    try {
      const res = await fetchUpstreamImage(candidate);
      if (!isImageishResponse(res)) {
        attempts.push(`${new URL(candidate).hostname}:${res.status}`);
        continue;
      }
      preferredProxyHost = new URL(candidate).hostname;
      return { res, host: preferredProxyHost, attempts };
    } catch {
      attempts.push(`${new URL(candidate).hostname}:err`);
    }
  }

  return { res: null, host: null, attempts };
}

/** Cache key by media path only so any CDN fill serves all hosts. */
function proxyCacheKey(target) {
  const u = new URL(target);
  return new Request(`https://jm-proxy-cache.internal${u.pathname}`, { method: 'GET' });
}

function buildProxyResponse(body, contentType, request, env, cacheStatus) {
  const out = new Headers();
  out.set('Content-Type', contentType || 'image/webp');
  // Browser + CF edge: comic pages are immutable enough for a day
  out.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
  out.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (cacheStatus) out.set('X-Proxy-Cache', cacheStatus);
  Object.entries(corsHeaders(request, env)).forEach(([k, v]) => out.set(k, v));
  Object.entries(securityHeaders()).forEach(([k, v]) => out.set(k, v));
  return new Response(body, { status: 200, headers: out });
}

async function handleProxy(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target || !isAllowedProxyUrl(target)) {
    return errorJson(400, '无效的图片代理 URL', request, env);
  }

  const cache = caches.default;
  const cacheReq = proxyCacheKey(target);

  try {
    const cached = await cache.match(cacheReq);
    if (cached) {
      // Re-wrap so CORS matches this request's Origin
      return buildProxyResponse(
        cached.body,
        cached.headers.get('Content-Type'),
        request,
        env,
        'HIT',
      );
    }
  } catch {
    /* cache optional */
  }

  try {
    const candidates = proxyCandidateUrls(target);
    const { res, attempts } = await fetchFirstGoodImage(candidates, 2);
    if (!res) {
      return jsonResponse(
        {
          code: 502,
          success: false,
          error: '图片代理失败',
          detail: attempts.join(', ') || 'no attempts',
        },
        502,
        request,
        env,
      );
    }

    const ct = (res.headers.get('Content-Type') || '').toLowerCase() || 'image/webp';
    // Buffer once so we can both return and put in edge cache
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength < 32) {
      return jsonResponse(
        {
          code: 502,
          success: false,
          error: '图片代理失败',
          detail: 'empty body',
        },
        502,
        request,
        env,
      );
    }

    const response = buildProxyResponse(buf, ct, request, env, 'MISS');
    try {
      // Store a CORS-agnostic copy under the path key
      const toCache = buildProxyResponse(buf, ct, request, env, 'STORE');
      toCache.headers.set('Access-Control-Allow-Origin', '*');
      await cache.put(cacheReq, toCache);
    } catch {
      /* ignore put failures */
    }
    return response;
  } catch (e) {
    return jsonResponse(
      {
        code: 502,
        success: false,
        error: '图片代理失败',
        detail: e?.message || String(e),
      },
      502,
      request,
      env,
    );
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const minify = url.searchParams.get('format') === 'min';

  // Health
  if (url.searchParams.get('health') === '1') {
    return jsonResponse(
      {
        code: 200,
        success: true,
        diagnostics: {
          runtime: 'cloudflare-workers',
          kv: Boolean(env.JM_CACHE),
          version: '1.0.0',
        },
      },
      200,
      request,
      env,
      minify,
    );
  }

  const maxRate = parseInt(env.RATE_MAX_PER_MIN || '60', 10) || 60;
  const ip = clientIp(request);
  if (!checkRate(ip, maxRate)) {
    return errorJson(429, '请求过于频繁，请稍后重试', request, env, {
      retry_after: 60,
    });
  }

  const rawJmid = url.searchParams.get('jmid');
  if (!rawJmid) {
    return errorJson(400, '缺少参数 jmid', request, env);
  }

  let jmid;
  try {
    jmid = parseJmId(rawJmid);
  } catch {
    return errorJson(400, '无效的 JM ID', request, env);
  }

  const chapterParam = url.searchParams.get('chapter');
  const client = new JmClient({ kv: env.JM_CACHE });
  const t0 = Date.now();

  try {
    const albumResp = await client.callJson(ENDPOINT_ALBUM, { id: jmid });
    const { album, episodes } = parseAlbum(albumResp.data);

    // Metadata only
    if (!chapterParam) {
      return jsonResponse(
        {
          code: 200,
          success: true,
          data: {
            album,
            chapters: episodes.map((ep) => ({
              photo_id: ep.photo_id,
              title: ep.title,
              sort: ep.sort,
            })),
            chapters_total: episodes.length,
            elapsed_ms: Date.now() - t0,
            api_calls: client.requestCount,
          },
        },
        200,
        request,
        env,
        minify,
      );
    }

    let fetchIds;
    try {
      fetchIds = resolveChapterIds(chapterParam, episodes, MAX_CHAPTERS);
    } catch (e) {
      return errorJson(e.status || 400, e.message, request, env);
    }

    const scrambleId = await client.fetchScrambleId(fetchIds[0]);
    const cdn = client.pickCdn();
    const chapters = [];
    const errors = [];

    for (const pid of fetchIds) {
      try {
        const chResp = await client.callJson(ENDPOINT_CHAPTER, { id: pid });
        chapters.push(parseChapter(chResp.data, scrambleId, cdn));
      } catch {
        errors.push({ photo_id: pid, error: 'Failed' });
      }
    }

    const payload = {
      code: 200,
      success: true,
      data: {
        album,
        chapters,
        chapters_total: episodes.length,
        chapters_fetched: chapters.length,
        elapsed_ms: Date.now() - t0,
        api_calls: client.requestCount,
      },
    };
    if (errors.length) payload.data.fetch_errors = errors;

    return jsonResponse(payload, 200, request, env, minify);
  } catch (e) {
    const status = e.status || 502;
    if (status >= 500) {
      return errorJson(status, e.message || '上游服务不可用', request, env);
    }
    return errorJson(status, e.message || '错误', request, env);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request, env),
          ...securityHeaders(),
        },
      });
    }

    if (request.method !== 'GET') {
      return errorJson(405, '仅支持 GET', request, env);
    }

    const url = new URL(request.url);

    // Image proxy path
    if (url.pathname === '/proxy' || url.pathname === '/proxy/') {
      return handleProxy(request, env);
    }

    // Root API (same query style as PHP)
    if (url.pathname === '/' || url.pathname === '') {
      return handleApi(request, env);
    }

    return errorJson(404, 'Not Found', request, env);
  },
};
