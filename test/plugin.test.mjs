// Offline tests.
// - resolve: frameXTV's answers come from test/fixtures.json, a recording of the real API (node sdk/run.mjs --record …).
// - Home, browse, search and episodes: TMDB answers are small hand-written samples in TMDB's v3 shape, served through a stand-in
//   for kino.tmdb (the Node kit does not provide that call).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validate } from "../sdk/validate.mjs";
import { checkOutput, validateManifest } from "../sdk/contract.mjs";
import { createKino } from "../sdk/kino-shim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test", "fixtures.json");
const manifest = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8")).manifest;

const movie = (id, extra = {}) => ({ id, title: "Película " + id, original_title: "Movie " + id, release_date: "1999-03-30", poster_path: "/p" + id + ".jpg", backdrop_path: "/b" + id + ".jpg", overview: "Sinopsis " + id, genre_ids: [28, 878], vote_average: 8.2, original_language: "en", ...extra });
const show = (id, extra = {}) => ({ id, name: "Serie " + id, original_name: "Show " + id, first_air_date: "2008-01-20", poster_path: "/s" + id + ".jpg", overview: "Sinopsis " + id, genre_ids: [18, 80], vote_average: 9.1, original_language: "en", ...extra });
const anime = (id) => show(id, { name: "Anime " + id, original_name: "アニメ " + id, genre_ids: [16, 10759], original_language: "ja" });

const calls = [];
function fakeTmdb(path, params) {
  calls.push({ path, params });
  if (path === "/movie/popular") return { page: params.page, total_pages: 3, results: [movie(1), movie(2), { id: null }, { id: 5, title: "" }] };
  if (path === "/tv/popular") return { page: 1, total_pages: 1, results: [show(10), anime(11)] };
  if (path === "/discover/tv") return { page: 1, total_pages: 1, results: [anime(11), anime(12)] };
  if (path === "/search/multi") return { page: params.page, total_pages: 1, results: params.page === 1 ? [movie(1), show(10), { id: 99, media_type: "person", name: "Alguien" }].map((r) => (r.name === "Alguien" ? r : { ...r, media_type: r.title ? "movie" : "tv" })) : [] };
  if (path === "/search/movie") return { page: 1, total_pages: 1, results: [movie(3)] };
  if (path === "/tv/10") {
    if (params.append_to_response) {
      const out = { id: 10 };
      for (const k of params.append_to_response.split(",")) {
        const n = Number(k.split("/")[1]);
        out[k] = { season_number: n, episodes: [1, 2].map((e) => ({ episode_number: e, name: "Episodio " + e, overview: "x", still_path: "/e.jpg", air_date: "2008-01-2" + e, runtime: 47 })) };
      }
      return out;
    }
    return { ...show(10), genres: [{ id: 18 }, { id: 80 }], seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }] };
  }
  const e = new Error("sin datos");
  e.code = "not_found";
  throw e;
}

// A fresh `kino` over the recording for every call; `tmdb` only when asked (an old Kino has none).
const copy = join(mkdtempSync(join(tmpdir(), "frame-test-")), "plugin.mjs");
writeFileSync(copy, readFileSync(join(root, "plugin.js")));
const plugin = await import(pathToFileURL(copy).href);
function use({ withTmdb = true, lang = "es-CO" } = {}) {
  const k = createKino(manifest, { replay: fixtures, lang });
  // The kit's `kino` is frozen: the plugin gets a copy that has `tmdb` when the Kino being imitated has it.
  globalThis.kino = withTmdb ? { ...k.kino, tmdb: async (path, params) => fakeTmdb(path, params) } : k.kino;
  return k;
}
async function checked(fn, ...args) {
  const out = await plugin[fn](...args);
  const r = checkOutput(fn, out, manifest);
  assert.deepEqual(r.drops, [], "Kino would drop: " + r.drops.join("; "));
  return r.value;
}

test("the kit accepts the manifest and the code", async () => {
  const r = await validate(root, {});
  assert.deepEqual(r.problems, []);
});

test("home: rows with genre, TMDB ids and no invalid items", async () => {
  use();
  const rows = await checked("home");
  const popular = rows.find((r) => r.id === "popular-movie");
  assert.equal(popular.genre, "peliculas");
  assert.equal(popular.items.length, 2);
  assert.equal(popular.items[0].tmdb, 1);
  assert.equal(popular.items[0].id, "m1");
  assert.equal(popular.items[0].poster, "https://image.tmdb.org/t/p/w342/p1.jpg");
  assert.deepEqual(popular.items[0].genres, ["accion", "ciencia-ficcion"]);
  const animeRow = rows.find((r) => r.id === "anime");
  assert.equal(animeRow.genre, "anime");
  assert.ok(animeRow.items.every((i) => i.genres[0] === "anime" && i.kind === "series"));
  // A row whose request fails is left out; the rest of the Home stays.
  assert.ok(!rows.find((r) => r.id === "now-playing"));
});

test("home: in English the rows are in English and TMDB is asked in English", async () => {
  use({ lang: "en-US" });
  calls.length = 0;
  const rows = await plugin.home();
  assert.equal(rows.find((r) => r.id === "popular-movie").title, "Popular movies");
  assert.equal(calls[0].params.language, "en-US");
});

test("home without kino.tmdb (Kino older than 0.9.53) fails with a typed error, not a crash", async () => {
  use({ withTmdb: false });
  await assert.rejects(() => plugin.home(), (e) => e.code === "unavailable");
});

test("browse: pages with a cursor, ends on the last page, rejects unknown rows", async () => {
  use();
  const first = await checked("browse", "popular-movie", null);
  assert.equal(first.next, "2");
  const last = await plugin.browse("popular-movie", "3");
  assert.equal(last.next, undefined);
  await assert.rejects(() => plugin.browse("nope", null), (e) => e.code === "not_found");
  await assert.rejects(() => plugin.browse("popular-movie", "999"), (e) => e.code === "not_found");
});

test("search: movies and series, people left out, no repeats", async () => {
  use();
  const items = await checked("search", { q: "matrix", type: "any", year: 0, season: 0, episode: 0, tmdbId: 0, originalTitle: "", altTitles: [], cursor: null });
  assert.deepEqual(items.items.map((i) => i.id), ["m1", "t10"]);
  const only = await checked("search", { q: "matrix", type: "movie", cursor: null });
  assert.deepEqual(only.items.map((i) => i.id), ["m3"]);
  assert.deepEqual(await plugin.search({ q: "  ", type: "any" }), []);
});

test("episodes: seasons 1+, specials skipped, refs carry the season and episode", async () => {
  use();
  const r = await checked("episodes", "tv:10");
  assert.equal(r.episodes.length, 4);
  assert.equal(r.episodes[0].ref, "tv:10:1:1");
  assert.equal(r.series.ids.tmdb, 10);
  await assert.rejects(() => plugin.episodes("movie:1"), (e) => e.code === "not_found");
});

test("resolve a movie: the server the API picked plays, the others are listed lazily", async () => {
  use();
  const s = await checked("resolve", "movie:603");
  assert.equal(s.mime, "application/vnd.apple.mpegurl");
  assert.match(s.label, /^Headhunter XXXI/);
  // Every other server is a lazy copy { label, ref } that asks for that server alone; the one playing is not listed again.
  const lazy = (s.alternatives || []).filter((a) => a.ref);
  assert.deepEqual(lazy.map((a) => a.ref.split("@")[1]), ["super_barbarian", "bowler", "miner", "valkyrie", "hog_rider", "lava_hound", "backup"]);
  assert.ok(lazy.every((a) => a.ref.startsWith("movie:603@") && a.label));
  assert.ok(s.alternatives.length <= 8);
});

test("resolve a movie: every subtitle language, the person's first, all SubRip", async () => {
  use();
  const s = await checked("resolve", "movie:603");
  assert.equal(s.subtitles[0].lang, "es");
  assert.ok(s.subtitles.length > 10 && s.subtitles.length <= 30);
  const langs = new Set(s.subtitles.map((x) => x.lang));
  for (const l of ["es", "en", "fr", "pt-br", "ar", "zh"]) assert.ok(langs.has(l), "missing " + l);
  // OpenSubtitles files are SubRip even though the API says "vtt".
  assert.ok(s.subtitles.every((x) => x.format === "srt"));
  // English-speaking Kino: English first.
  use({ lang: "en-US" });
  const en = await checked("resolve", "movie:603");
  assert.equal(en.subtitles[0].lang, "en");
});

test("resolve one server by name: its own copies, then the other servers", async () => {
  use();
  const s = await checked("resolve", "movie:603@super_barbarian");
  assert.match(s.label, /^Super Barbarian XVI · 4K$/);
  const copies = s.alternatives.filter((a) => a.url);
  assert.ok(copies.length >= 1 && copies.every((a) => a.label.startsWith("Super Barbarian XVI")));
  const refs = s.alternatives.filter((a) => a.ref).map((a) => a.ref);
  assert.ok(!refs.some((r) => r.endsWith("@super_barbarian")));
  assert.ok(refs.includes("movie:603@headhunter"));
  assert.ok(s.alternatives.length <= 8);
});

test("resolve Bowler: its dubs are not offered as copies of the original", async () => {
  use();
  const s = await checked("resolve", "movie:603@bowler");
  assert.match(s.label, /^Bowler XVIII/);
  assert.ok(!(s.alternatives || []).some((a) => a.url), "a dub came as a copy");
});

test("resolve an episode: HLS, with the servers of that episode", async () => {
  use();
  const s = await checked("resolve", "tv:1396:1:1");
  assert.equal(s.mime, "application/vnd.apple.mpegurl");
  assert.ok(s.subtitles.some((x) => x.lang === "es"));
  assert.ok(s.alternatives.some((a) => a.ref === "tv:1396:1:1@headhunter"));
});

test("a server that cannot play the title says so in the person's words", async () => {
  use();
  await assert.rejects(() => plugin.resolve("movie:603@miner"), (e) => e.code === "rate_limited" && /otro/.test(e.userMessage || ""));
  await assert.rejects(() => plugin.resolve("tv:1396:1:1@headhunter"), (e) => e.code === "not_found" && /servidor/i.test(e.userMessage || ""));
});

test("resolve: a title the server does not have is not_found; bad refs and servers too", async () => {
  use();
  await assert.rejects(() => plugin.resolve("movie:999999999"), (e) => e.code === "not_found");
  await assert.rejects(() => plugin.resolve("tv:1396"), (e) => e.code === "not_found");
  await assert.rejects(() => plugin.resolve("movie:603@nope"), (e) => e.code === "not_found");
  await assert.rejects(() => plugin.resolve("???"), (e) => e.code === "not_found");
});
