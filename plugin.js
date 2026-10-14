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

// A ref is "movie:<tmdb>", "tv:<tmdb>" (a series) or "tv:<tmdb>:<season>:<episode>", plus an optional "@<server>" that asks
// frameXTV for that server only (see SERVERS).
function parseRef(ref) {
  const m = /^(movie|tv):(\d{1,9})(?::(\d{1,3}):(\d{1,5}))?(?:@([a-z_]{2,20}))?$/.exec(String(ref || ""));
  if (!m) return null;
  return { type: m[1], id: Number(m[2]), season: m[3] ? Number(m[3]) : null, episode: m[4] ? Number(m[4]) : null, server: m[5] || null };
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
// A response is { success, provider, sources: [{ url, quality, type: "mp4"|"hls", server, headers? }], subtitles: [...] }.
// Some sources already point at /api/proxy on the API host; the rest sit on CDNs of every kind.
//
// frameXTV's own site offers eight servers. Asking the API with &provider=<id> returns that server's answer alone; without it
// the API picks one. resolve() plays the one asked (or the one the API picked) and lists the other servers as lazy copies
// { label, ref }, which Kino (and brntv) resolve only when the person picks that server.
const SERVERS = [
  { id: "super_barbarian", name: "Super Barbarian XVI", tag: "4K" },
  { id: "headhunter", name: "Headhunter XXXI", tag: "FHD" },
  { id: "bowler", name: "Bowler XVIII", tag: "FHD", multi: true },
  { id: "miner", name: "Miner XIX", tag: "4K" },
  { id: "valkyrie", name: "Valkyrie VI", tag: "4K" },
  { id: "hog_rider", name: "Hog Rider XI", tag: "4K" },
  { id: "lava_hound", name: "Lava Hound XII", tag: "4K" },
  { id: "backup", name: "Backup", tag: "" },
];
const SERVER_BY_ID = {};
for (const sv of SERVERS) SERVER_BY_ID[sv.id] = sv;

function clip(text, max) {
  const x = String(text || "");
  return x.length > max ? x.slice(0, max - 1) + "…" : x;
}

// "Bowler XVIII · FHD · Multi-idioma": the name, then what the server is known for (the menu shows the rest as chips).
function serverLabel(sv) {
  const tags = [sv.tag, sv.multi ? t("Multi-idioma", "Multi-language") : ""].filter(Boolean);
  return clip([sv.name].concat(tags).join(" · "), 48);
}

function qualityRank(s) {
  const q = String(s.quality || "");
  const n = /(\d{3,4})p/.exec(q);
  if (/4k/i.test(q)) return 2160;
  return n ? Number(n[1]) : 0;
}

// "4K" or "1080p" when the source says it, else "".
function resolutionLabel(s) {
  const q = String(s.quality || "");
  if (/4k/i.test(q)) return "4K";
  const all = q.match(/\d{3,4}p/g);
  return all ? all.sort((a, b) => parseInt(b, 10) - parseInt(a, 10))[0] : "";
}

function isHls(s) {
  return s.type === "hls" || /\.m3u8(\?|$)/i.test(s.url);
}

// The copies that play the original audio: Bowler also lists dubs ("1080p | Hindi"), which are other languages, not other copies.
function sameLanguage(list) {
  const original = list.filter((s) => !/\|\s*(?!english|inglés|ingles)\S/i.test(String(s.quality || "")));
  return original.length ? original : list;
}

function plainHeaders(h) {
  if (!h || typeof h !== "object") return undefined;
  const out = {};
  let n = 0;
  for (const k of Object.keys(h)) {
    if (n >= 20 || typeof h[k] !== "string" || /^(host|content-length|cookie)$/i.test(k)) continue;
    out[k] = h[k];
    n++;
  }
  return n ? out : undefined;
}

function streamOf(s, label) {
  const out = { url: s.url, mime: isHls(s) ? HLS_MIME : "video/mp4", label: clip(label, 48) };
  const headers = plainHeaders(s.headers);
  if (headers) out.headers = headers;
  return out;
}

// Language names the API gives instead of a code (its own, "native" subtitles), written in their own script.
const LANG_NAMES = {
  english: "en", español: "es", espanol: "es", français: "fr", francais: "fr", deutsch: "de", italiano: "it", português: "pt",
  portugues: "pt", indonesian: "id", "bahasa indonesia": "id", filipino: "fil", русский: "ru", українська: "uk", polski: "pl",
  türkçe: "tr", nederlands: "nl", svenska: "sv", dansk: "da", suomi: "fi", norsk: "no", čeština: "cs", magyar: "hu", română: "ro",
  ελληνικά: "el", עברית: "he", العربية: "ar", فارسی: "fa", اردو: "ur", বাংলা: "bn", हिन्दी: "hi", தமிழ்: "ta", తెలుగు: "te",
  ไทย: "th", "tiếng việt": "vi", "bahasa melayu": "ms", 中文: "zh", 日本語: "ja", 한국어: "ko",
};

function subtitleCode(s) {
  const code = String(s.lang || "").toLowerCase().trim();
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code)) return code;
  // Vowel signs are dropped so "اَلْعَرَبِيَّةُ" matches "العربية".
  const name = String(s.label || s.language || "").toLowerCase().replace(/[\u064B-\u065F\u0670]/g, "").trim();
  return LANG_NAMES[name] || "";
}

// Every language the API offers (Kino keeps 30): the person's language first, then English, then the rest by code. At most two
// files per language, none with an overlong address.
function subtitleTracks(list) {
  const first = english() ? ["en", "es"] : ["es", "en"];
  const found = [];
  const taken = new Set();
  const perLang = {};
  for (const s of list || []) {
    const code = subtitleCode(s);
    if (!code || !s.url || String(s.url).length > 2000 || taken.has(s.url)) continue;
    perLang[code] = (perLang[code] || 0) + 1;
    if (perLang[code] > 2) continue;
    taken.add(s.url);
    // The API labels OpenSubtitles files "vtt" but serves SubRip (checked on real answers): trust the source, not the label.
    const srt = s.format === "srt" || s.source === "opensubtitles" || /\.srt(\?|$)/i.test(s.url);
    found.push({ lang: code, url: s.url, format: srt ? "srt" : "vtt" });
  }
  const rank = (c) => {
    const i = first.indexOf(c.split("-")[0]);
    return i === -1 ? 99 : i;
  };
  return found
    .map((x, i) => ({ x, i }))
    .sort((a, b) => {
      const ra = rank(a.x.lang);
      const rb = rank(b.x.lang);
      if (ra !== rb) return ra - rb;
      if (ra === 99 && a.x.lang !== b.x.lang) return a.x.lang < b.x.lang ? -1 : 1;
      return a.i - b.i;
    })
    .map((e) => e.x)
    .slice(0, 30);
}

// What the person reads when a server cannot play the title (Kino shows it when it passes its rules: Spanish or English, no URLs).
function failure(code, detail) {
  return kino.error(code, detail, {
    userMessage: t(
      "Este servidor no tiene el video ahora. Prueba otro desde el menú de servidores.",
      "This server does not have the video right now. Try another one from the server menu.",
    ),
  });
}

export async function resolve(ref) {
  await null;
  const p = parseRef(ref);
  if (!p || (p.type === "tv" && p.season === null)) throw kino.error("not_found", "ese título ya no existe");
  if (p.server && !SERVER_BY_ID[p.server]) throw kino.error("not_found", "ese servidor no existe");
  let url = API + "/api/stream?type=" + p.type + "&id=" + p.id;
  if (p.type === "tv") url += "&season=" + p.season + "&episode=" + p.episode;
  if (p.server) url += "&provider=" + p.server;
  const r = await kino.fetch(url);
  if (!r.ok) throw kino.error(r.status === 429 ? "rate_limited" : "unavailable", "frameXTV respondió " + r.status);
  let data;
  try {
    data = await r.json();
  } catch {
    throw kino.error("unavailable", "frameXTV no devolvió JSON");
  }
  const sources = ((data && data.sources) || []).filter((s) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url));
  if (!data || !data.success || !sources.length) {
    const why = String((data && data.error) || "");
    throw failure(/\b429\b|rate/i.test(why) ? "rate_limited" : "not_found", "frameXTV no tiene este título en este servidor");
  }
  // The server that answers: the one asked for, else the one the API picked.
  const used = (p.server && SERVER_BY_ID[p.server]) || SERVER_BY_ID[data.provider] || null;
  const name = used ? used.name : t("Servidor automático", "Automatic server");
  // HLS first (it adapts to the connection), then by quality; dubs are left out.
  const ordered = sameLanguage(sources).sort((a, b) => isHls(b) - isHls(a) || qualityRank(b) - qualityRank(a));
  const best = ordered[0];
  const main = streamOf(best, name + " · " + (resolutionLabel(best) || (used && used.tag) || "auto"));
  // Other copies of this same video on this server (other qualities, other CDNs), then the other servers, lazily: 8 at most.
  const copies = ordered.slice(1, 4).map((s, i) => streamOf(s, name + " · " + (resolutionLabel(s) || ((/\(([^)]+)\)/.exec(String(s.server || "")) || [])[1]) || t("copia ", "copy ") + (i + 1))));
  const base = p.type + ":" + p.id + (p.type === "tv" ? ":" + p.season + ":" + p.episode : "");
  const others = SERVERS.filter((sv) => !used || sv.id !== used.id)
    .slice(0, 8 - copies.length)
    .map((sv) => ({ label: serverLabel(sv), ref: base + "@" + sv.id }));
  return {
    ...main,
    subtitles: subtitleTracks(data.subtitles),
    alternatives: copies.concat(others),
    expiresInSeconds: 1200,
  };
}
