import { SCRAMBLE_268850, SCRAMBLE_421926 } from './config.js';
import { md5 } from './crypto.js';

/**
 * Compute decode_segments for a page image.
 * Official JMComic-Crawler-Python uses filename WITHOUT extension
 * (JmImageTool.get_num / of_file_name(..., trim_suffix=True)).
 */
export function scrambleSegments(scrambleId, aid, filename) {
  const sid = parseInt(scrambleId, 10);
  const a = parseInt(aid, 10);

  if (a < sid) return 0;
  if (a < SCRAMBLE_268850) return 10;

  // Strip extension: "00001.webp" → "00001"
  const base = String(filename).replace(/\.[^./\\]+$/, '');
  const x = a < SCRAMBLE_421926 ? 10 : 8;
  const h = md5(String(a) + base);
  const n = h.charCodeAt(h.length - 1) % x;
  return n * 2 + 2;
}

export function parseAlbum(data) {
  const album = {
    album_id: String(data.id),
    name: data.name ?? '',
    author: data.author ?? [],
    description: data.description ?? '',
    total_views: data.total_views ?? '0',
    likes: data.likes ?? '0',
    comments: String(data.comment_total ?? '0'),
    tags: data.tags ?? [],
    works: data.works ?? [],
    actors: data.actors ?? [],
    related: data.related_list ?? [],
  };

  let episodes = [];
  for (const ch of data.series ?? []) {
    episodes.push({
      photo_id: String(ch.id),
      sort: String(ch.sort ?? '1'),
      title: ch.name ?? '',
    });
  }

  if (episodes.length === 0) {
    episodes = [
      {
        photo_id: String(data.id),
        sort: '1',
        title: album.name,
      },
    ];
  } else {
    episodes.sort((a, b) => parseInt(a.sort, 10) - parseInt(b.sort, 10));
    const seen = new Set();
    episodes = episodes.filter((ep) => {
      if (seen.has(ep.sort)) return false;
      seen.add(ep.sort);
      return true;
    });
  }

  album.chapters = episodes.length;
  return { album, episodes };
}

export function parseChapter(data, scrambleId, cdn) {
  const photoId = String(data.id);
  let sort = '1';
  for (const ch of data.series ?? []) {
    if (String(ch.id) === photoId) {
      sort = String(ch.sort ?? '1');
      break;
    }
  }

  const images = (data.images ?? []).map((fn, i) => ({
    index: i + 1,
    filename: fn,
    url: `https://${cdn}/media/photos/${photoId}/${fn}`,
    scramble_id: scrambleId,
    decode_segments: scrambleSegments(scrambleId, photoId, fn),
  }));

  return {
    photo_id: photoId,
    title: data.name ?? '',
    sort,
    page_count: images.length,
    images,
  };
}

/** Parse jmid from raw input (digits, JM prefix, album URL). */
export function parseJmId(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 200) {
    const e = new Error('Invalid JM ID');
    e.status = 400;
    throw e;
  }
  let m = s.match(/^JM(\d+)$/i);
  if (m) return m[1];
  m = s.match(/\/(?:album|photo)s?\/(\d+)/i);
  if (m) return m[1];
  m = s.match(/[?&]id=(\d+)/i);
  if (m) return m[1];
  m = s.match(/^(\d+)$/);
  if (m) return m[1];
  const e = new Error('Invalid JM ID');
  e.status = 400;
  throw e;
}

/**
 * Resolve chapter param against album episodes.
 * @returns {string[]} photo ids
 */
export function resolveChapterIds(param, episodes, maxChapters = 50) {
  const p = String(param ?? '').trim();
  const allIds = episodes.map((e) => e.photo_id);

  if (p.toLowerCase() === 'all') {
    if (allIds.length > maxChapters) {
      const e = new Error(`章节过多（${allIds.length}），单次最多 ${maxChapters} 章`);
      e.status = 400;
      throw e;
    }
    return allIds;
  }

  if (p.startsWith('@')) {
    const idx = parseInt(p.slice(1), 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > episodes.length) {
      const e = new Error(`章节序号 ${idx} 超出范围 1-${episodes.length}`);
      e.status = 400;
      throw e;
    }
    return [episodes[idx - 1].photo_id];
  }

  if (p.includes(',')) {
    const parts = p.split(',').map((x) => x.trim());
    if (parts.length > maxChapters) {
      const e = new Error(`单次最多 ${maxChapters} 章`);
      e.status = 400;
      throw e;
    }
    const valid = parts.filter((id) => /^\d+$/.test(id) && allIds.includes(id));
    if (!valid.length) {
      const e = new Error('未找到有效章节 ID');
      e.status = 400;
      throw e;
    }
    return valid;
  }

  if (/^\d+$/.test(p) && allIds.includes(p)) return [p];

  const e = new Error('无效的章节参数');
  e.status = 400;
  throw e;
}
