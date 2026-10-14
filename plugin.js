// Kino plugin: Frame (frameXTV) — movies, series and anime.
// The catalog (Home, search, seasons) comes from TMDB through kino.tmdb, which needs Kino 0.9.53+ and no key of ours.
// The video comes from frameXTV's stream endpoint, which answers by TMDB id:
//   GET https://api.framextv.tech/api/stream?type=movie|tv&id=<tmdb>[&season=<s>&episode=<e>]
// Declared hosts: the API (and its /api/proxy, which wraps some copies) and TMDB's image server. The video itself sits on CDNs
// that change, hence "streamHosts": "any" in the manifest.

const API = "https://api.framextv.tech";
const IMG = "https://image.tmdb.org/t/p";
const MAX_PAGES = 20;
const HLS_MIME = "application/vnd.apple.mpegurl";

// kino.log never breaks what it reports on: in Kino 0.9.43 release builds a call to it threw.
function log(...args) {
  try {
    kino.log(...args);
  } catch {
    // the log line is lost, the result is not
  }
}

// kino.lang is "es-CO" or, from Kino 0.9.54, "en-US": every text built here follows it.
function english() {
  return String(kino.lang || "").toLowerCase().startsWith("en");
}

function t(es, en) {
  return english() ? en : es;
}

// ---- TMDB ------------------------------------------------------------------------------------------------------------
// The first await comes before any throw: Kino 0.9.49 and older abort the whole call on an earlier one.
async function tmdb(path, params) {
  await null;
  if (typeof kino.tmdb !== "function") throw kino.error("unavailable", "falta kino.tmdb (Kino 0.9.53)");
  return kino.tmdb(path, { language: english() ? "en-US" : "es-MX", ...params });
}

// TMDB genre id -> Kino genre id (movies and series share most of them).
const GENRES = {
  28: "accion", 12: "aventura", 16: "animacion", 35: "comedia", 80: "crimen", 99: "documentales", 18: "drama",
  10751: "familia", 14: "fantasia", 36: "historia", 27: "terror", 10402: "musical", 9648: "misterio", 10749: "romance",
  878: "ciencia-ficcion", 53: "suspenso", 10752: "belica", 37: "western", 10759: "accion", 10762: "infantil",
  10763: "noticias", 10764: "reality", 10765: "ciencia-ficcion", 10766: "drama", 10767: "entretenimiento", 10768: "belica",
};

function isAnime(r) {
  return r.original_language === "ja" && Array.isArray(r.genre_ids) && r.genre_ids.includes(16);
}

function image(size, path) {
  return typeof path === "string" && path.startsWith("/") ? IMG + "/" + size + path : undefined;
}

function toItem(r, type) {
  if (!r || !Number.isInteger(r.id)) return null;
  const tv = type === "tv";
  const title = String((tv ? r.name : r.title) || "").trim();
  if (!title) return null;
  const date = String((tv ? r.first_air_date : r.release_date) || "");
  const genres = [];
  if (isAnime(r)) genres.push("anime");
  for (const g of r.genre_ids || []) if (GENRES[g] && !genres.includes(GENRES[g])) genres.push(GENRES[g]);
  const original = String((tv ? r.original_name : r.original_title) || "").trim();
  return {
    id: (tv ? "t" : "m") + r.id,
    ref: (tv ? "tv:" : "movie:") + r.id,
    title: title.slice(0, 200),
    kind: tv ? "series" : "movie",
    year: /^\d{4}/.test(date) ? date.slice(0, 4) : undefined,
    poster: image("w342", r.poster_path),
    backdrop: image("w780", r.backdrop_path),
    overview: r.overview ? String(r.overview).slice(0, 500) : undefined,
    originalTitle: original && original !== title ? original.slice(0, 200) : undefined,
    genres: genres.slice(0, 5),
    rating: r.vote_average > 0 ? Math.round(r.vote_average * 10) / 10 : undefined,
    ids: { tmdb: r.id },
  };
}

function itemsOf(data, type) {
  const out = [];
  for (const r of (data && data.results) || []) {
    const item = toItem(r, type);
    if (item) out.push(item);
  }
  return out;
}

// ---- Home and "Ver más" -------------------------------------------------------------------------------------------------
const ROWS = [
  { id: "popular-movie", es: "Películas populares", en: "Popular movies", path: "/movie/popular", type: "movie", genre: "peliculas" },
  { id: "popular-tv", es: "Series populares", en: "Popular series", path: "/tv/popular", type: "tv", genre: "series" },
  { id: "anime", es: "Anime", en: "Anime", path: "/discover/tv", type: "tv", genre: "anime",
    params: { with_genres: "16", with_original_language: "ja", sort_by: "popularity.desc" } },
  { id: "now-playing", es: "En cartelera", en: "In theaters", path: "/movie/now_playing", type: "movie", genre: "peliculas" },
  { id: "top-movie", es: "Películas mejor valoradas", en: "Top rated movies", path: "/movie/top_rated", type: "movie", genre: "peliculas" },
  { id: "top-tv", es: "Series mejor valoradas", en: "Top rated series", path: "/tv/top_rated", type: "tv", genre: "series" },
];

async function rowPage(row, page) {
  return tmdb(row.path, { ...(row.params || {}), page });
}

export async function home() {
  const failures = [];
  const rows = await Promise.all(
    ROWS.map(async (row) => {
      try {
        const items = itemsOf(await rowPage(row, 1), row.type);
        return items.length ? { id: row.id, title: t(row.es, row.en), ref: row.id, genre: row.genre, items } : null;
      } catch (e) {
        failures.push(e);
        log("home row failed", row.id, e && e.code);
        return null;
      }
    }),
  );
  const out = rows.filter(Boolean);
  // Every row failed: show the reason (Kino words it) instead of an empty Home.
  if (!out.length && failures.length) throw failures[0];
  return out;
}

export async function browse(ref, cursor) {
  await null; // the checks below may throw: never before the first await
  const row = ROWS.find((r) => r.id === ref);
  if (!row) throw kino.error("not_found", "esa fila ya no existe");
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) throw kino.error("not_found", "página inválida");
  const data = await rowPage(row, page);
  const more = data && data.total_pages > page && page < MAX_PAGES;
  return { items: itemsOf(data, row.type), next: more ? String(page + 1) : undefined };
}

// ---- Search -------------------------------------------------------------------------------------------------------------
export async function search(query) {
  await null;
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const kind = query.type === "movie" ? "movie" : query.type === "series" ? "tv" : "multi";
  const pages = await Promise.all(
    [1, 2, 3].map((page) =>
      tmdb("/search/" + kind, { query: q, page, include_adult: false }).catch((e) => {
        log("search page failed", page, e && e.code);
        return null;
      }),
    ),
  );
  const out = [];
  const seen = new Set();
  for (const data of pages) {
    for (const r of (data && data.results) || []) {
      const type = kind === "multi" ? r.media_type : kind;
      if (type !== "movie" && type !== "tv") continue;
      const item = toItem(r, type);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  if (!out.length && pages.every((p) => p === null)) throw kino.error("unavailable", "la búsqueda de TMDB no respondió");
  return out.slice(0, 100);
}

// ---- Seasons and episodes -----------------------------------------------------------------------------------------------
const APPEND_LIMIT = 19; // TMDB appends at most 20 sub-requests to one call

function parseRef(ref) {
  const m = /^(movie|tv):(\d{1,9})(?::(\d{1,3}):(\d{1,5}))?$/.exec(String(ref || ""));
  if (!m) return null;
  return { type: m[1], id: Number(m[2]), season: m[3] ? Number(m[3]) : null, episode: m[4] ? Number(m[4]) : null };
}

export async function episodes(ref) {
  await null;
  const p = parseRef(ref);
  if (!p || p.type !== "tv" || p.season !== null) throw kino.error("not_found", "esa serie ya no existe");
  const show = await tmdb("/tv/" + p.id, {});
  const numbers = (show.seasons || []).map((s) => s.season_number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 999);
  const seasons = [];
  for (let i = 0; i < numbers.length; i += APPEND_LIMIT) {
    const chunk = numbers.slice(i, i + APPEND_LIMIT);
    const data = await tmdb("/tv/" + p.id, { append_to_response: chunk.map((n) => "season/" + n).join(",") });
    for (const n of chunk) if (data["season/" + n]) seasons.push(data["season/" + n]);
  }
  const list = [];
  for (const s of seasons) {
    for (const e of s.episodes || []) {
      if (!Number.isInteger(e.episode_number) || e.episode_number < 1) continue;
      list.push({
        season: s.season_number,
        number: e.episode_number,
        ref: "tv:" + p.id + ":" + s.season_number + ":" + e.episode_number,
        title: e.name ? String(e.name).slice(0, 200) : undefined,
        still: image("w300", e.still_path),
        overview: e.overview ? String(e.overview).slice(0, 500) : undefined,
        airDate: /^\d{4}-\d{2}-\d{2}$/.test(e.air_date || "") ? e.air_date : undefined,
        runtimeMinutes: e.runtime > 0 && e.runtime <= 1000 ? e.runtime : undefined,
      });
    }
  }
  const item = toItem({ ...show, genre_ids: (show.genres || []).map((g) => g.id) }, "tv");
  return {
    series: {
      title: item ? item.title : String(show.name || ""),
      poster: item && item.poster,
      backdrop: item && item.backdrop,
      overview: item && item.overview,
      ids: { tmdb: p.id },
      genres: item && item.genres,
      year: item && item.year,
    },
    episodes: list,
  };
}

// ---- Video --------------------------------------------------------------------------------------------------------------
// A response is { success, provider, sources: [{ url, quality, type: "mp4"|"hls", server, skipProxy? }], subtitles: [...] }.
// Some sources already point at /api/proxy on the API host; the rest sit on CDNs of every kind.
function qualityRank(s) {
  const q = String(s.quality || "");
  const n = /(\d{3,4})p/.exec(q);
  if (/4k/i.test(q)) return 2160;
  return n ? Number(n[1]) : 0;
}

function toStream(s) {
  const hls = s.type === "hls" || /\.m3u8(\?|$)/i.test(s.url);
  return { url: s.url, mime: hls ? HLS_MIME : "video/mp4", label: [s.server, s.quality].filter(Boolean).join(" · ").slice(0, 48) || undefined };
}

// Subtitles: the person's language first, then English; at most 6 tracks, none with an overlong address.
function subtitleTracks(list) {
  const want = english() ? ["en", "es"] : ["es", "en"];
  const out = [];
  const taken = new Set();
  for (const lang of want) {
    for (const s of list || []) {
      const code = String(s.lang || "").toLowerCase();
      if (code !== lang || !s.url || String(s.url).length > 2000 || taken.has(s.url)) continue;
      taken.add(s.url);
      // The API labels OpenSubtitles files "vtt" but serves SubRip (checked on real answers): trust the source, not the label.
      const srt = s.format === "srt" || s.source === "opensubtitles" || /\.srt(\?|$)/i.test(s.url);
      out.push({ lang, url: s.url, format: srt ? "srt" : "vtt" });
      if (out.filter((x) => x.lang === lang).length >= 3) break;
    }
  }
  return out.slice(0, 6);
}

export async function resolve(ref) {
  await null;
  const p = parseRef(ref);
  if (!p || (p.type === "tv" && p.season === null)) throw kino.error("not_found", "ese título ya no existe");
  let url = API + "/api/stream?type=" + p.type + "&id=" + p.id;
  if (p.type === "tv") url += "&season=" + p.season + "&episode=" + p.episode;
  const r = await kino.fetch(url);
  if (!r.ok) throw kino.error(r.status === 429 ? "rate_limited" : "unavailable", "frameXTV respondió " + r.status);
  let data;
  try {
    data = await r.json();
  } catch {
    throw kino.error("unavailable", "frameXTV no devolvió JSON");
  }
  const sources = ((data && data.sources) || []).filter((s) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url));
  if (!data || !data.success || !sources.length) throw kino.error("not_found", "frameXTV no tiene este título por ahora");
  // HLS first (it adapts to the connection), then by quality.
  sources.sort((a, b) => (b.type === "hls") - (a.type === "hls") || qualityRank(b) - qualityRank(a));
  const [best, ...rest] = sources.map(toStream);
  const alternatives = rest.slice(0, 8).map(({ url: u, mime, label }) => ({ url: u, mime, label }));
  return {
    ...best,
    subtitles: subtitleTracks(data.subtitles),
    alternatives: alternatives.length ? alternatives : undefined,
    expiresInSeconds: 1200,
  };
}
