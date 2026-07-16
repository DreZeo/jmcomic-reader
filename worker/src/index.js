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

/** Same path on every known CDN host (primary first). */
function proxyCandidateUrls(primary) {
  const u = new URL(primary);
  const hosts = [u.hostname, ...[...ALLOWED_CDN_HOSTS].filter((h) => h !== u.hostname)];
  return hosts.map((h) => `https://${h}${u.pathname}${u.search}`);
}

async function fetchUpstreamImage(targetUrl) {
  const headers = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://18comic.vip/',
    Origin: 'https://18comic.vip',
  };

  // Prefer plain fetch — cf cache options can break some upstreams.
  let res = await fetch(targetUrl, {
    method: 'GET',
    headers,
    redirect: 'follow',
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
    });
  }

  return res;
}

async function handleProxy(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target || !isAllowedProxyUrl(target)) {
    return errorJson(400, '无效的图片代理 URL', request, env);
  }

  const attempts = [];
  try {
    for (const candidate of proxyCandidateUrls(target)) {
      try {
        const res = await fetchUpstreamImage(candidate);
        if (!res.ok) {
          attempts.push(`${new URL(candidate).hostname}:${res.status}`);
          continue;
        }

        // Some CDNs return HTML error pages with 200 — require image-ish type or bytes
        const ct = (res.headers.get('Content-Type') || '').toLowerCase();
        if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream') && !ct.includes('webp')) {
          attempts.push(`${new URL(candidate).hostname}:bad-ct:${ct}`);
          continue;
        }

        const out = new Headers();
        out.set('Content-Type', ct || 'image/webp');
        out.set('Cache-Control', 'public, max-age=3600');
        // Allow canvas read from Pages
        out.set('Cross-Origin-Resource-Policy', 'cross-origin');
        Object.entries(corsHeaders(request, env)).forEach(([k, v]) => out.set(k, v));
        Object.entries(securityHeaders()).forEach(([k, v]) => out.set(k, v));

        return new Response(res.body, { status: 200, headers: out });
      } catch (e) {
        attempts.push(`${new URL(candidate).hostname}:err`);
        continue;
      }
    }

    // Surface detail so frontend/debug can see why (not generic 服务器内部错误)
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
