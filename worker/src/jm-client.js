import {
  VERSION,
  TOKEN_SECRET,
  TOKEN_SECRET2,
  DATA_SECRET,
  DOMAIN_SECRET,
  ENDPOINT_SCRAMBLE,
  SCRAMBLE_220980,
  API_DOMAINS,
  DOMAIN_SERVER_URLS,
  CDN_DOMAINS,
  UA,
  HTTP_TIMEOUT_MS,
  MAX_RETRIES,
  DOMAIN_CACHE_TTL,
  SCRAMBLE_CACHE_TTL,
} from './config.js';
import { md5, decryptApiData, decryptDomainBlob } from './crypto.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {KVNamespace | undefined} opts.kv
 */
export class JmClient {
  constructor({ kv } = {}) {
    this.kv = kv;
    this.requestCount = 0;
    this.domains = null;
  }

  async getDomains() {
    if (this.domains) return this.domains;

    if (this.kv) {
      try {
        const cached = await this.kv.get('api-domains', 'json');
        if (Array.isArray(cached) && cached.length) {
          this.domains = cached;
          return this.domains;
        }
      } catch {
        /* ignore */
      }
    }

    for (const url of DOMAIN_SERVER_URLS) {
      try {
        const res = await fetchWithTimeout(url, {}, 10000);
        if (!res.ok) continue;
        let body = await res.text();
        // Strip leading non-ASCII noise (same as PHP)
        while (body.length > 0 && body.charCodeAt(0) > 127) {
          body = body.slice(1);
        }
        body = body.trim();
        if (!body) continue;

        const plain = decryptDomainBlob(body, DOMAIN_SECRET);
        const data = JSON.parse(plain);
        const servers = data?.Server;
        if (Array.isArray(servers) && servers.length) {
          this.domains = servers;
          if (this.kv) {
            await this.kv.put('api-domains', JSON.stringify(servers), {
              expirationTtl: DOMAIN_CACHE_TTL,
            });
          }
          return this.domains;
        }
      } catch {
        continue;
      }
    }

    this.domains = [...API_DOMAINS];
    return this.domains;
  }

  buildAuthHeaders(secret = TOKEN_SECRET) {
    const ts = String(Math.floor(Date.now() / 1000));
    const token = md5(ts + secret);
    const tokenparam = `${ts},${VERSION}`;
    return {
      ts,
      headers: {
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': UA,
        token,
        tokenparam,
      },
    };
  }

  /**
   * Call JM JSON API (album/chapter), decrypt response.
   * @returns {Promise<{ts: string, data: object}>}
   */
  async callJson(path, params) {
    const domains = await this.getDomains();
    const { ts, headers } = this.buildAuthHeaders(TOKEN_SECRET);
    const qs = new URLSearchParams(params).toString();
    const urlPath = `${path}?${qs}`;

    let lastError = 'unknown';

    for (const domain of domains) {
      const url = `https://${domain}${urlPath}`;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        if (retry > 0) await sleep(300);
        try {
          this.requestCount++;
          const res = await fetchWithTimeout(url, { headers, method: 'GET' });
          if (res.status >= 500) {
            lastError = `HTTP ${res.status}`;
            continue;
          }
          const json = await res.json();
          if (!json || json.code !== 200 || !json.data) {
            lastError = `code ${json?.code ?? 'null'}`;
            continue;
          }
          const decrypted = decryptApiData(json.data, ts, DATA_SECRET);
          const resData = JSON.parse(decrypted);
          return { ts, data: resData };
        } catch (e) {
          lastError = e?.message || String(e);
          continue;
        }
      }
    }

    const err = new Error(`API 域名全部不可用: ${lastError}`);
    err.status = 502;
    throw err;
  }

  async fetchScrambleId(photoId) {
    const cacheKey = `scramble:${photoId}`;
    if (this.kv) {
      try {
        const cached = await this.kv.get(cacheKey);
        if (cached) return cached;
      } catch {
        /* ignore */
      }
    }

    const domains = await this.getDomains();
    const { headers } = this.buildAuthHeaders(TOKEN_SECRET2);
    const qs = new URLSearchParams({
      id: photoId,
      mode: 'vertical',
      page: '0',
      app_img_shunt: '1',
    }).toString();
    const urlPath = `${ENDPOINT_SCRAMBLE}?${qs}`;

    for (const domain of domains) {
      const url = `https://${domain}${urlPath}`;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        if (retry > 0) await sleep(300);
        try {
          this.requestCount++;
          const res = await fetchWithTimeout(url, { headers, method: 'GET' });
          if (!res.ok || res.status >= 500) continue;
          const body = await res.text();
          const m = body.match(/var\s+scramble_id\s*=\s*(\d+);/);
          if (m) {
            const id = m[1];
            if (this.kv) {
              await this.kv.put(cacheKey, id, { expirationTtl: SCRAMBLE_CACHE_TTL });
            }
            return id;
          }
        } catch {
          continue;
        }
      }
    }

    return String(SCRAMBLE_220980);
  }

  pickCdn() {
    return CDN_DOMAINS[Math.floor(Math.random() * CDN_DOMAINS.length)];
  }
}
