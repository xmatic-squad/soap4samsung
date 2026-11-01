"use strict";
var assert = require("node:assert/strict");
var test = require("node:test");
var fs = require("node:fs");
var vm = require("node:vm");
var SoapStore = require("../app/store.js");
var PREFIX = "soap4samsung.local.";

function storage() {
  var data = Object.create(null);
  var result = {
    writes: [],
    capacity: Infinity,
    fail: false,
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem: function (key, value) {
      value = String(value);
      var size = Object.keys(data).reduce(function (sum, name) { return sum + 2 * (name.length + data[name].length); }, 0);
      var previous = result.getItem(key);
      if (result.fail || size - (previous === null ? 0 : 2 * (key.length + previous.length)) + 2 * (key.length + value.length) > result.capacity) {
        var error = new Error("Synthetic quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      data[key] = value;
      result.writes.push(key);
    },
    removeItem: function (key) { delete data[key]; },
    key: function (index) { return Object.keys(data)[index] || null; },
    bytes: function () { return Object.keys(data).reduce(function (sum, key) { return sum + 2 * (key.length + data[key].length); }, 0); }
  };
  Object.defineProperty(result, "length", {get: function () { return Object.keys(data).length; }});
  return result;
}
function fixture() {
  var disk = storage();
  var time = 100;
  var errors = [];
  var store = new SoapStore({storage: disk, now: function () { return time++; }, onWriteError: function (error) { errors.push(error); }});
  return {store: store, disk: disk, errors: errors};
}
function episode(sid, season, number) { return {kind: "episode", sid: sid, season: season, episode: number}; }
function movie(id) { return {kind: "movie", id: id}; }
function snapshot(position, duration, played, ended) { return {positionMs: position, durationMs: duration, playedSinceSeekMs: played, ended: ended === true}; }
function show(sid, title) { return {sid: sid, title: title || "Synthetic show"}; }

test("threshold requires both 90 percent and thirty seconds since the last seek", function () {
  var f = fixture();
  var media = episode(1, 1, 1);
  assert.equal(f.store.get(media), null);
  assert.equal(f.store.saveProgress(media, snapshot(90000, 100000, 0)).status, "progress");
  assert.equal(f.store.saveProgress(media, snapshot(99000, 100000, 29999)).status, "progress");
  assert.equal(f.store.saveProgress(media, snapshot(89999, 100000, 30000)).status, "progress");
  var saved = f.store.saveProgress(media, snapshot(90000, 100000, 30000));
  assert.deepEqual(saved, {status: "watched", positionMs: 0, durationMs: 100000, updatedAt: 103});
  assert.equal(f.store.resumeMs(media, 50), 0);
  assert.equal(f.store.effectiveWatched(media, 0), true);
});

test("ended marks even with unknown duration, but truthy non-booleans do not", function () {
  var f = fixture();
  var media = movie(1);
  assert.equal(f.store.saveProgress(media, {ended: "true"}).status, "progress");
  assert.equal(f.store.saveProgress(media, {ended: true}).status, "watched");
  assert.equal(f.store.saveProgress(movie(2), snapshot(100, 0, 30000)).status, "progress");
});

test("repeated ended and late progress callbacks cannot downgrade or move watched records", function () {
  var f = fixture();
  var media = episode(1, 2, 3);
  var watched = f.store.saveProgress(media, snapshot(100000, 100000, 0, true), show(1));
  var writes = f.disk.writes.length;
  assert.deepEqual(f.store.saveProgress(media, snapshot(20000, 200000, 1000), show(1, "Late")), watched);
  assert.deepEqual(f.store.saveProgress(media, snapshot(0, 0, 0, true)), watched);
  assert.deepEqual(f.store.setWatched(media, true), watched);
  assert.equal(f.disk.writes.length, writes);
  assert.equal(f.store.nextEpisodeLabel(1), null);
  assert.equal(f.store.continueList("show", 6)[0].record.status, "watched");
});

test("manual unwatch overrides the server and survives reopening; only it lowers watched", function () {
  var f = fixture();
  var media = episode(1, 1, 1);
  assert.equal(f.store.effectiveWatched(media, "1"), true);
  f.store.setWatched(media, true);
  var cleared = f.store.setWatched(media, false);
  assert.deepEqual(cleared, {status: "unwatched", positionMs: 0, durationMs: 0, updatedAt: 101});
  assert.equal(f.store.effectiveWatched(media, "1"), false);
  assert.equal(new SoapStore({storage: f.disk}).effectiveWatched(media, 1), false);
  var writes = f.disk.writes.length;
  f.store.setWatched(media, false);
  assert.equal(f.disk.writes.length, writes);
});

test("episode identity uses sid/season/episode, canonicalizes numeric strings, and ignores eid", function () {
  var f = fixture();
  f.store.saveProgress({kind: "episode", sid: "001", season: "02", episode: "3", eid: 55}, snapshot(70000, 500000, 100));
  assert.equal(f.store.get(episode(1, 2, 3)).positionMs, 70000);
  assert.equal(f.store.get(episode(1, 2, 4)), null);
  assert.equal(f.store.get(movie(1)), null);
  assert.deepEqual(f.disk.writes, [PREFIX + "show.1"]);
  f.store.saveProgress(movie("01"), snapshot(90000, 1000000, 0));
  assert.equal(f.store.get(movie(1)).positionMs, 90000);
});

test("resume has strict sixty-second boundary, rewind, local priority and seconds fallback", function () {
  var f = fixture();
  var media = movie(1);
  assert.equal(f.store.resumeMs(media, "72.5"), 72500);
  f.store.saveProgress(media, snapshot(60000, 1000000, 0));
  assert.equal(f.store.resumeMs(media, 90), 0);
  f.store.saveProgress(media, snapshot(60001, 1000000, 0));
  assert.equal(f.store.resumeMs(media, 90), 55001);
  f.store.setWatched(media, false);
  assert.equal(f.store.resumeMs(media, 90), 0);
  [NaN, Infinity, -5, "bad", {}, true, "0x10"].forEach(function (value) { assert.equal(f.store.resumeMs(movie(2), value), 0); });
});

test("bad snapshot types and server number strings remain finite and do not throw", function () {
  var f = fixture();
  [NaN, Infinity, -5, "bad", {}, true, "", null, undefined].forEach(function (value, index) {
    var saved = f.store.saveProgress(movie(index), snapshot(value, value, value));
    assert.equal(saved.status, "progress");
    assert.equal(saved.positionMs, 0);
    assert.equal(saved.durationMs, 0);
  });
  assert.equal(f.store.saveProgress(movie(99), snapshot("90000", "100000", "30000")).status, "watched");
  assert.equal(f.store.saveProgress(movie(100), null).status, "progress");
  assert.equal(f.store.effectiveWatched(movie(101), "0"), false);
});

test("invalid ids and prototype keys cannot write or pollute objects", function () {
  var f = fixture();
  ["__proto__", "constructor", {}, [], NaN, Infinity, -1, "1.2", "1e1", "9007199254740992"].forEach(function (value) {
    assert.equal(f.store.saveProgress(episode(value, 1, 1), {ended: true}), null);
    assert.equal(f.store.setWatched(episode(1, value, 1), true), null);
    assert.equal(f.store.toggleFavorite("show", show(value)), false);
    assert.equal(f.store.isFavorite("__proto__", value), false);
  });
  assert.equal(f.disk.length, 0);
  assert.equal({}.polluted, undefined);
});

test("corrupt documents and unsupported schemas are isolated, with valid records retained", function () {
  var f = fixture();
  f.disk.setItem(PREFIX + "show.1", "{broken");
  f.disk.setItem(PREFIX + "favorites", "[]");
  f.disk.setItem(PREFIX + "movie.1", JSON.stringify({schemaVersion: 99, record: {status: "watched"}}));
  f.disk.setItem(PREFIX + "show.2", '{"schemaVersion":1,"episodes":{"1:1":{"status":"watched","positionMs":-9,"durationMs":"12","updatedAt":"4"},"1:2":{"status":"bad"},"__proto__":{"polluted":true}},"serverWatched":{"__proto__":true}}');
  assert.equal(f.store.get(episode(1, 1, 1)), null);
  assert.equal(f.store.get(movie(1)), null);
  assert.deepEqual(f.store.favorites("show"), []);
  assert.deepEqual(f.store.get(episode(2, 1, 1)), {status: "watched", positionMs: 0, durationMs: 12, updatedAt: 4});
  assert.equal(f.store.get(episode(2, 1, 2)), null);
  f.store.setWatched(episode(1, 1, 1), true);
  assert.equal(f.store.get(episode(2, 1, 1)).status, "watched");
  assert.equal({}.polluted, undefined);
});

test("page reads parse each document once per instance and public results cannot mutate the cache", function () {
  var disk = storage();
  var initial = new SoapStore({storage: disk});
  initial.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0), show(1));
  initial.toggleFavorite("show", show(1));
  var parses = 0;
  var context = {module: {exports: {}}, JSON: {parse: function (value) { parses += 1; return JSON.parse(value); }, stringify: JSON.stringify}};
  vm.runInNewContext(fs.readFileSync(require.resolve("../app/store.js"), "utf8"), context);
  var store = new context.module.exports({storage: disk});
  for (var i = 0; i < 5; i += 1) {
    store.get(episode(1, 1, 1)).positionMs = 1;
    store.nextEpisodeLabel(1);
    store.continueList("show", 6)[0].card.title = "Changed externally";
    store.favorites("show")[0].title = "Changed externally";
    store.isFavorite("show", 1);
  }
  assert.equal(parses, 2);
  assert.equal(store.get(episode(1, 1, 1)).positionMs, 70000);
  assert.equal(store.favorites("show")[0].title, "Synthetic show");
  assert.equal(store.continueList("show", 6)[0].card.title, "Synthetic show");
});

test("UMD exposes a constructor on the TV window without DOM dependencies", function () {
  var context = {window: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve("../app/store.js"), "utf8"), context);
  assert.equal(typeof context.window.SoapStore, "function");
  assert.equal(new context.window.SoapStore({storage: storage()}).get(movie(1)), null);
});

test("normal progress updates write only the media document; bulk marks write once", function () {
  var f = fixture();
  f.store.toggleFavorite("show", show(1));
  f.store.saveProgress(movie(1), snapshot(1000, 100000, 0));
  f.disk.writes.length = 0;
  f.store.saveProgress(episode(1, 1, 1), snapshot(10000, 100000, 0));
  assert.deepEqual(f.disk.writes, [PREFIX + "show.1"]);
  f.disk.writes.length = 0;
  f.store.setEpisodesWatched("1", [{season: 1, episode: 1}, {season: "1", episode: "2"}, {season: "__proto__", episode: 9}], true, show(1));
  assert.deepEqual(f.disk.writes, [PREFIX + "show.1"]);
  assert.equal(f.store.get(episode(1, 1, 1)).status, "watched");
  assert.equal(f.store.get(episode(1, 1, 2)).status, "watched");
  assert.equal(f.store.get(episode(1, 1, 3)), null);
});

test("adjusted unwatched persists signed corrections and follows newly returned server counts", function () {
  var f = fixture();
  var episodes = [{season: 1, episode: 1, watched: "0"}, {season: "1", episode: "2", watched: "1"}, {season: 1, episode: 3, watched: 0}];
  f.store.syncShowEpisodes("1", episodes);
  f.store.setWatched(episode(1, 1, 1), true);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: "2"}), 1);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 4}), 3);
  f.store.setWatched(episode(1, 1, 2), false);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 2}), 2);
  f.store.setWatched(episode(1, 1, 1), false);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 2}), 3);
  assert.equal(f.store.adjustedUnwatched({sid: 1}), 0);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: null}), 0);
  [NaN, Infinity, -1, "bad", {}, true].forEach(function (value) {
    assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: value}), 0);
  });
  var doc = JSON.parse(f.disk.getItem(PREFIX + "show.1"));
  assert.equal(doc.serverUnwatched, 2);
  assert.equal(doc.adjustment, -1);
  assert.equal(new SoapStore({storage: f.disk}).adjustedUnwatched({sid: "1", unwatched: "2"}), 3);
  f.store.setEpisodesWatched(1, episodes, true);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 2}), 0);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 0}), 0);
  f.store.setEpisodesWatched(1, episodes, false);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 2}), 3);
  f.store.syncShowEpisodes(1, episodes.concat([{season: 2, episode: 1, watched: 0}]));
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 3}), 4);
});

test("sync recomputes correction when the server catches up or episodes leave the list", function () {
  var f = fixture();
  f.store.setWatched(episode(1, 1, 1), true);
  f.store.syncShowEpisodes(1, [{season: 1, episode: 1, watched: 0}]);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 1}), 0);
  f.store.syncShowEpisodes(1, [{season: 1, episode: 1, watched: 1}]);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 1}), 1);
  f.store.syncShowEpisodes(1, []);
  assert.equal(f.store.adjustedUnwatched({sid: 1, unwatched: 1}), 1);
});

test("continue lists use snapshots, latest progress per show, limits and separate movie state", function () {
  var f = fixture();
  f.store.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0), show(1, "Earlier"));
  f.store.saveProgress(episode(1, 2, 3), snapshot(80000, 300000, 0), show(1, "Latest"));
  f.store.saveProgress(episode(2, 1, 1), snapshot(90000, 400000, 0), show(2));
  f.store.saveProgress(movie(1), snapshot(90000, 400000, 0), {id: 1, title: "Movie"});
  f.store.setWatched(episode(3, 1, 1), true, show(3));
  f.store.setWatched(episode(4, 1, 1), false, show(4));
  assert.deepEqual(f.store.continueList("show", 6).map(function (entry) { return entry.media.sid; }), ["3", "2", "1"]);
  assert.deepEqual(f.store.continueList("show", 1)[0].media, episode("3", 1, 1));
  assert.equal(f.store.continueList("show", 6)[2].card.title, "Latest");
  assert.equal(f.store.continueList("movie", 6)[0].card.title, "Movie");
  assert.deepEqual(f.store.nextEpisodeLabel("1"), {season: 2, episode: 3, positionMs: 80000, durationMs: 300000});
  f.store.setWatched(episode(1, 2, 3), true);
  assert.equal(f.store.nextEpisodeLabel(1).episode, 1);
  assert.equal(f.store.nextEpisodeLabel(99), null);
  assert.deepEqual(f.store.continueList("show", 0), []);
  assert.deepEqual(f.store.continueList("invalid", 6), []);
  assert.deepEqual(new SoapStore({storage: f.disk}).continueList("show", 6), f.store.continueList("show", 6));
});

test("favorite import happens once across restarts, including empty import", function () {
  var f = fixture();
  assert.equal(f.store.importFavoritesOnce([show(1), show("2"), show(1)]), true);
  assert.equal(f.store.isFavorite("show", "1"), true);
  assert.equal(f.store.toggleFavorite("show", show(1)), false);
  assert.equal(f.store.importFavoritesOnce([show(1), show(3)]), false);
  var reopened = new SoapStore({storage: f.disk});
  assert.equal(reopened.importFavoritesOnce([show(1)]), false);
  assert.equal(reopened.isFavorite("show", 1), false);
  assert.equal(reopened.isFavorite("show", 3), false);
  assert.equal(JSON.parse(f.disk.getItem(PREFIX + "meta")).favoritesImported, true);
  var empty = fixture();
  assert.equal(empty.store.importFavoritesOnce([]), true);
  assert.equal(empty.store.importFavoritesOnce([show(1)]), false);
});

test("favorites stay separate, newest first; refresh changes snapshots without importing or reordering", function () {
  var f = fixture();
  f.store.toggleFavorite("show", show(1));
  f.store.toggleFavorite("show", show(2));
  f.store.toggleFavorite("movie", {id: 1, title: "Movie"});
  f.store.refreshCards("show", [show(1, "Fresh"), show(3)]);
  assert.deepEqual(f.store.favorites("show").map(function (item) { return item.sid; }), ["2", "1"]);
  assert.equal(f.store.favorites("show")[1].title, "Fresh");
  assert.equal(f.store.isFavorite("show", 3), false);
  assert.equal(f.store.favorites("movie")[0].title, "Movie");
  assert.deepEqual(f.store.favorites("__proto__"), []);
});

test("updates in the same clock millisecond keep the most recent progress and favorite first", function () {
  var store = new SoapStore({storage: storage(), now: function () { return 100; }});
  store.saveProgress(episode(1, 2, 2), snapshot(70000, 200000, 0), show(1));
  store.saveProgress(episode(1, 1, 1), snapshot(80000, 200000, 0), show(1));
  assert.equal(store.nextEpisodeLabel(1).episode, 1);
  store.saveProgress(episode(1, 2, 2), snapshot(90000, 200000, 0), show(1));
  assert.equal(store.nextEpisodeLabel(1).episode, 2);
  store.toggleFavorite("show", show(1));
  store.toggleFavorite("show", show(2));
  assert.equal(store.favorites("show")[0].sid, "2");
});

test("card snapshots have only whitelisted scalars and safe covers", function () {
  var input = {sid: 1, id: 9, title: " Title ", title_ru: "Название", title_original: "Original", soap: "Soap", soap_ru: "Сериал", year: "2026", imdb_rating: "8.1", kinopoisk_rating: 11, soap_rating: "9", unwatched: "0", runtime: "45", covers: {small: "https://images.example/small.jpg", big: "https://images.example/big.jpg"}, description: "private", token: "synthetic", stream: "https://video.example/test"};
  assert.deepEqual(SoapStore.card("show", input), {sid: "1", title: "Title", title_ru: "Название", title_original: "Original", soap: "Soap", soap_ru: "Сериал", year: 2026, imdb_rating: 8.1, soap_rating: 9, unwatched: 0, runtime: 45, covers: {small: "https://images.example/small.jpg"}});
  assert.deepEqual(SoapStore.card("movie", {id: 1, title: {}, year: NaN, covers: {big: "http://images.example/big.jpg"}}), {id: "1", covers: {big: "http://images.example/big.jpg"}});
  ["data:image/png;base64,AAAA", "javascript:alert(1)", "//images.example/a", "file:///tmp/a", "https://", "https://images.example/a\n"].forEach(function (url) {
    assert.equal(SoapStore.card("show", {sid: 1, covers: {small: url, big: "https://images.example/big.jpg"}}).covers, undefined);
  });
  assert.equal(SoapStore.card("show", null), null);
});

test("write failures do not pretend to save a record, favorite or import flag", function () {
  var f = fixture();
  f.store.setWatched(movie(1), true);
  var previous = f.store.get(movie(1));
  f.disk.fail = true;
  assert.doesNotThrow(function () {
    assert.deepEqual(f.store.setWatched(movie(1), false), previous);
    assert.equal(f.store.saveProgress(movie(2), snapshot(70000, 100000, 0)), null);
    assert.equal(f.store.toggleFavorite("show", show(1)), false);
    assert.equal(f.store.importFavoritesOnce([show(1)]), false);
  });
  assert.equal(f.store.get(movie(2)), null);
  assert.equal(f.store.isFavorite("show", 1), false);
  assert.equal(f.errors.length, 4);
  f.disk.fail = false;
  assert.equal(f.store.importFavoritesOnce([show(1)]), true);
});

test("failed updates preserve the previous position and correction, even if the error callback throws", function () {
  var disk = storage();
  var store = new SoapStore({storage: disk, onWriteError: function () { throw new Error("Synthetic UI failure"); }});
  store.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0));
  store.syncShowEpisodes(1, [{season: 1, episode: 1, watched: 0}]);
  disk.fail = true;
  var previous = store.get(episode(1, 1, 1));
  assert.deepEqual(store.saveProgress(episode(1, 1, 1), snapshot(80000, 200000, 0)), previous);
  assert.deepEqual(store.setWatched(episode(1, 1, 1), true), previous);
  assert.equal(store.adjustedUnwatched({sid: 1, unwatched: 1}), 1);
});

test("a non-quota failure does not evict unrelated progress or snapshots", function () {
  var f = fixture();
  f.store.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0), show(1));
  var original = f.disk.getItem(PREFIX + "show.1");
  f.disk.setItem = function () {
    var error = new Error("Synthetic storage failure");
    error.name = "SecurityError";
    throw error;
  };
  assert.equal(f.store.setWatched(movie(1), true), null);
  assert.equal(f.errors.length, 1);
  assert.equal(f.disk.getItem(PREFIX + "show.1"), original);
  assert.equal(f.store.nextEpisodeLabel(1).positionMs, 70000);
});

test("evictions preceding a failed mutation stay durable and cached reads agree with storage", function () {
  var f = fixture();
  f.store.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0), show(1));
  f.store.setWatched(episode(1, 1, 2), true);
  var setItem = f.disk.setItem;
  f.disk.setItem = function (key, value) {
    if (key === PREFIX + "movie.2") {
      var error = new Error("Synthetic persistent quota error");
      error.name = "QuotaExceededError";
      throw error;
    }
    setItem(key, value);
  };
  assert.equal(f.store.setWatched(movie(2), true), null);
  assert.equal(f.errors.length, 1);
  assert.equal(f.store.get(episode(1, 1, 1)), null);
  assert.equal(f.store.nextEpisodeLabel(1), null);
  assert.equal(f.store.get(episode(1, 1, 2)).status, "watched");
  var reopened = new SoapStore({storage: f.disk});
  assert.deepEqual(reopened.get(episode(1, 1, 1)), f.store.get(episode(1, 1, 1)));
  assert.deepEqual(reopened.get(episode(1, 1, 2)), f.store.get(episode(1, 1, 2)));
});

test("actual storage quota triggers eviction of old snapshots and progress, preserving watched and favorites", function () {
  var f = fixture();
  f.store.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0), show(1, "x".repeat(2000)));
  f.store.setWatched(episode(1, 1, 2), true);
  f.store.toggleFavorite("show", show(2, "y".repeat(2000)));
  f.disk.capacity = f.disk.bytes() + 100;
  f.store.setWatched(movie(3), true, {id: 3, title: "z".repeat(1500)});
  assert.equal(f.store.get(movie(3)).status, "watched");
  assert.equal(f.store.get(episode(1, 1, 2)).status, "watched");
  assert.equal(f.store.isFavorite("show", 2), true);
  assert.equal(f.store.nextEpisodeLabel(1), null);
  assert.equal(f.errors.length, 0);
  assert.ok(f.disk.bytes() <= f.disk.capacity);
});

test("one MiB budget is summed across module keys and evicts the oldest disposable data", function () {
  var f = fixture();
  var title = "x".repeat(180000);
  f.store.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0), show(1, title));
  f.store.setWatched(episode(1, 1, 2), true);
  f.store.toggleFavorite("show", show(2, title));
  f.store.saveProgress(movie(3), snapshot(70000, 200000, 0), {id: 3, title: title});
  assert.ok(f.disk.bytes() <= 1024 * 1024);
  assert.equal(f.store.get(episode(1, 1, 2)).status, "watched");
  assert.equal(f.store.isFavorite("show", 2), true);
  assert.equal(f.store.nextEpisodeLabel(1), null);
  assert.equal(f.store.continueList("movie", 6).length, 1);
  assert.equal(f.errors.length, 0);
  assert.equal(new SoapStore({storage: f.disk}).get(episode(1, 1, 2)).status, "watched");
});

test("oversized favorite snapshots shrink to identity without evicting membership", function () {
  var f = fixture();
  assert.equal(f.store.toggleFavorite("show", show(1, "x".repeat(600000))), true);
  assert.deepEqual(f.store.favorites("show"), [{sid: "1"}]);
  assert.ok(f.disk.bytes() <= 1024 * 1024);
  assert.equal(f.errors.length, 0);
});

test("the working budget excludes other modules' keys", function () {
  var f = fixture();
  f.disk.setItem("other-module", "x".repeat(600000));
  f.store.saveProgress(episode(1, 1, 1), snapshot(70000, 200000, 0), show(1));
  assert.ok(f.disk.bytes() > 1024 * 1024);
  assert.equal(f.store.nextEpisodeLabel(1).positionMs, 70000);
  assert.equal(f.store.continueList("show", 6).length, 1);
  assert.equal(f.errors.length, 0);
});

test("unrecoverable full budget reports failure without evicting watched or favorites", function () {
  var f = fixture();
  var episodes = {};
  for (var i = 0; i < 7000; i += 1) episodes["1:" + i] = {status: "watched", positionMs: 0, durationMs: 100000, updatedAt: 1};
  f.disk.setItem(PREFIX + "show.1", JSON.stringify({schemaVersion: 1, episodes: episodes}));
  assert.ok(f.disk.bytes() > 1024 * 1024);
  assert.equal(f.store.setWatched(movie(1), true), null);
  assert.equal(f.errors.length, 1);
  assert.equal(f.store.get(episode(1, 1, 0)).status, "watched");
  assert.equal(f.store.get(episode(1, 1, 6999)).status, "watched");
});

test("reset removes only module data, clears caches, and permits importing again", function () {
  var f = fixture();
  f.disk.setItem("soap4samsung.token", "synthetic token");
  f.disk.setItem("soap4samsung.sort.shows", "title");
  f.disk.setItem("soap4samsung.locality.other", "unrelated");
  f.store.importFavoritesOnce([show(1)]);
  f.store.setWatched(episode(1, 1, 1), true);
  f.store.setWatched(movie(1), true);
  f.store.reset();
  assert.equal(f.disk.length, 3);
  assert.equal(f.disk.getItem("soap4samsung.token"), "synthetic token");
  assert.equal(f.disk.getItem("soap4samsung.sort.shows"), "title");
  assert.equal(f.store.get(episode(1, 1, 1)), null);
  assert.deepEqual(f.store.favorites("show"), []);
  assert.equal(f.store.importFavoritesOnce([show(1)]), true);
});

test("unavailable storage reports write errors without throwing or inventing data", function () {
  var errors = [];
  var store = new SoapStore({storage: {getItem: function () { throw new Error("Synthetic denied access"); }, get length() { throw new Error("Synthetic denied access"); }}, onWriteError: function (error) { errors.push(error); }});
  assert.equal(store.saveProgress(movie(1), {ended: true}), null);
  assert.deepEqual(store.continueList("movie", 6), []);
  assert.doesNotThrow(function () { store.reset(); });
  assert.equal(errors.length, 2);
});

test("rewatching an episode the service marks watched keeps it watched", function () {
  var store = new SoapStore({storage: storage(), now: function () { return 1000; }});
  var media = {kind: "episode", sid: 7, season: 1, episode: 2};
  store.syncShowEpisodes(7, [{season: 1, episode: 2, watched: 1}]);
  store.saveProgress(media, {positionMs: 90000, durationMs: 1000000, playedSinceSeekMs: 90000, ended: false});
  assert.equal(store.effectiveWatched(media, 1), true);
  assert.equal(store.adjustedUnwatched({sid: 7, unwatched: 0}), 0);
  assert.equal(store.resumeMs(media, 0), 85000);
});

test("playback after an explicit unmark does not restore the service status", function () {
  var store = new SoapStore({storage: storage()});
  var media = {kind: "episode", sid: 7, season: 1, episode: 2};
  store.setWatched(media, false);
  store.saveProgress(media, {positionMs: 90000, durationMs: 1000000, playedSinceSeekMs: 90000, ended: false});
  assert.equal(store.effectiveWatched(media, 1), false);
  var reread = new SoapStore({storage: store.storage});
  assert.equal(reread.effectiveWatched(media, 1), false);
});

test("a zero position neither creates a mark nor erases the saved position", function () {
  var store = new SoapStore({storage: storage()});
  var media = {kind: "movie", id: 3};
  store.saveProgress(media, {positionMs: 0, durationMs: 1000, playedSinceSeekMs: 0, ended: false});
  assert.equal(store.effectiveWatched(media, 1), true);
  store.saveProgress(media, {positionMs: 120000, durationMs: 1000000, playedSinceSeekMs: 90000, ended: false});
  store.saveProgress(media, {positionMs: 0, durationMs: 1000000, playedSinceSeekMs: 0, ended: false});
  assert.equal(store.get(media).positionMs, 120000);
});

test("the show continue entry follows the newest activity, including a finished episode", function () {
  var time = 100;
  var store = new SoapStore({storage: storage(), now: function () { time += 1; return time; }});
  var card = {sid: 7, title: "Synthetic", unwatched: 2};
  store.saveProgress({kind: "episode", sid: 7, season: 1, episode: 1}, {positionMs: 90000, durationMs: 1000000, playedSinceSeekMs: 0, ended: false}, card);
  store.saveProgress({kind: "episode", sid: 7, season: 1, episode: 2}, {positionMs: 1, durationMs: 1000000, playedSinceSeekMs: 0, ended: true}, card);
  var list = store.continueList("show", 5);
  assert.equal(list.length, 1);
  assert.equal(list[0].record.status, "watched");
  assert.equal(list[0].media.episode, 2);
});
