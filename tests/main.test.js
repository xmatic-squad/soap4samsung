"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var test = require("node:test");
var vm = require("node:vm");

// Run the real application entry point and its modal controllers. This small
// DOM models focus, native Enter clicks, event bubbling and detached elements;
// layout and firmware behavior remain part of the browser/TV smoke checks.
function harness(options) {
  options = options || {};
  var ids = {};
  var requests = [];
  var saved = Object.assign({"soap4samsung.token": "synthetic-session"}, options.saved);
  var timeline = [];
  var timers = [];
  var now = 10000;
  var player;
  var document = {activeElement: null, hidden: false};
  var listeners = {};
  var exits = 0;
  function emit(name, event) { (listeners[name] || []).forEach(function (fn) { fn(event); }); }
  function descendants(item) {
    return item.children.reduce(function (all, child) { return all.concat(child, descendants(child)); }, []);
  }
  function matches(item, selector) {
    if (selector.indexOf(":not(:disabled)") !== -1 && item.disabled) return false;
    selector = selector.replace(":not(:disabled)", "");
    if (selector === "[data-focus]") return item.getAttribute("data-focus") !== null;
    if (selector.charAt(0) === "#") return item.id === selector.slice(1);
    if (selector.charAt(0) === ".") return selector.slice(1).split(".").every(function (name) { return item.classList.contains(name); });
    return item.tagName.toLowerCase() === selector;
  }
  function query(item, selectors) {
    return descendants(item).filter(function (child) {
      return selectors.split(",").some(function (selector) {
        var parts = selector.trim().split(/\s+/);
        if (!matches(child, parts.pop())) return false;
        var ancestor = child.parentNode;
        while (parts.length && ancestor) {
          if (matches(ancestor, parts[parts.length - 1])) parts.pop();
          ancestor = ancestor.parentNode;
        }
        return !parts.length;
      });
    });
  }
  function element(tag) {
    var attributes = {};
    var events = {};
    var text = "";
    var item = {tagName: tag.toUpperCase(), children: [], parentNode: null, id: "", className: "", style: {}, hidden: false, disabled: false, value: "", scrollWidth: 500};
    function setClass(name, enabled) {
      var names = item.className.split(/\s+/).filter(function (value) { return value && value !== name; });
      if (enabled) names.push(name);
      item.className = names.join(" ");
    }
    item.classList = {
      toggle: setClass,
      add: function (name) { setClass(name, true); },
      remove: function (name) { setClass(name, false); },
      contains: function (name) { return item.className.split(/\s+/).indexOf(name) !== -1; }
    };
    item.appendChild = function (child) {
      if (child.tagName === "FRAGMENT") { child.children.slice().forEach(item.appendChild); child.children = []; return child; }
      child.parentNode = item; item.children.push(child); return child;
    };
    item.contains = function (child) { return child === item || descendants(item).indexOf(child) !== -1; };
    item.removeChild = function (child) {
      if (child.contains(document.activeElement)) document.activeElement = document.body;
      item.children.splice(item.children.indexOf(child), 1);
      child.parentNode = null;
    };
    item.setAttribute = function (name, value) {
      attributes[name] = String(value);
      if (name === "id") { item.id = String(value); ids[item.id] = item; }
      if (name === "class") item.className = String(value);
      if (name === "hidden") item.hidden = true;
    };
    item.getAttribute = function (name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; };
    item.removeAttribute = function (name) { delete attributes[name]; };
    item.addEventListener = function (name, fn) { (events[name] || (events[name] = [])).push(fn); };
    item.focus = function () { if (item.getBoundingClientRect().width && !item.disabled)  { document.activeElement = item; emit("focusin", {target: item}); } };
    item.blur = function () { document.activeElement = document.body; };
    item.click = function () {
      if (item.disabled) return;
      var event = {target: item, detail: 0, preventDefault: function () {}};
      (events.click || []).forEach(function (fn) { fn(event); });
      emit("click", event);
    };
    item.querySelectorAll = function (selector) { return query(item, selector); };
    item.querySelector = function (selector) { return query(item, selector)[0] || null; };
    item.scrollIntoView = function () {};
    item.getBoundingClientRect = function () {
      for (var ancestor = item; ancestor; ancestor = ancestor.parentNode) {
        if (ancestor.hidden) return {width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0};
      }
      return {width: 100, height: 40, top: 100, bottom: 140, left: 100, right: 200};
    };
    Object.defineProperty(item, "firstChild", {get: function () { return item.children[0] || null; }});
    Object.defineProperty(item, "textContent", {
      get: function () { return text + item.children.map(function (child) { return child.textContent; }).join(""); },
      set: function (value) { while (item.firstChild) item.removeChild(item.firstChild); text = String(value); }
    });
    if (tag === "template") {
      item.content = {textContent: ""};
      Object.defineProperty(item, "innerHTML", {set: function (value) { item.content.textContent = value.replace(/<[^>]*>/g, ""); }});
    }
    return item;
  }
  var root = element("root");
  var stack = [root];
  var html = fs.readFileSync(path.join(__dirname, "../app/index.html"), "utf8");
  html.replace(/<(\/?)([a-z][\w-]*)([^>]*)>/gi, function (_, closing, tag, attributes) {
    if (closing) { stack.pop(); return ""; }
    var item = element(tag);
    attributes.replace(/([\w-]+)(?:="([^"]*)")?/g, function (_, name, value) { item.setAttribute(name, value || ""); return ""; });
    stack[stack.length - 1].appendChild(item);
    if (tag === "body") document.body = item;
    if (tag === "html") document.documentElement = item;
    if (!/^(meta|link|input|img|br|hr)$/.test(tag)) stack.push(item);
    return "";
  });
  document.activeElement = document.body;
  document.getElementById = function (id) { assert.ok(ids[id], "Real index contains " + id); return ids[id]; };
  document.createElement = element;
  document.createDocumentFragment = function () { return element("fragment"); };
  document.querySelectorAll = function (selector) { return query(root, selector); };
  document.addEventListener = function (name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); };
  function request(kind, args) {
    return new Promise(function (resolve, reject) { requests.push({kind: kind, args: args, resolve: resolve, reject: reject}); });
  }
  function Api(options) { this.token = options.token; }
  Api.prototype.getToken = function () { return this.token; };
  Api.prototype.setToken = function (token) { this.token = token; };
  Api.prototype.getMyShows = function () { return request("my"); };
  Api.prototype.getAllShows = function () { return request("all"); };
  Api.prototype.getMovies = function () { return request("movies"); };
  Api.prototype.getEpisodes = function (sid) { return request("episodes", sid); };
  Api.prototype.normalizeEpisodes = function (episodes) { return episodes; };
  Api.prototype.chooseRussianFile = function (files) { return (files || []).filter(function (file) { return file.translate === 4; })[0]; };
  Api.prototype.getPlayback = function (sid, file) { return request("play", {sid: sid, file: file}); };
  Api.prototype.getMoviePlayback = function (mid) { return request("movie-play", mid); };
  function Player(options) { this.active = false; this.options = options; this.starts = []; this.checkpoint = null; player = this; }
  Player.prototype.snapshot = function () { return this.active ? this.checkpoint : null; };
  Player.prototype.stop = function (notify, message, reason) {
    var snapshot = this.snapshot();
    if (snapshot) snapshot = Object.assign({}, snapshot, {ended: reason === "ended"});
    this.active = false;
    timeline.push({type: "stop"});
    if (notify) this.options.onStop(message, reason, snapshot);
  };
  Player.prototype.start = function (playback, title) {
    timeline.push({type: "start", playback: playback});
    this.starts.push(playback);
    this.active = true;
    this.checkpoint = {positionMs: 0, durationMs: 1200000, playedSinceSeekMs: 0};
    this.options.onStart();
  };
  Player.prototype.handleKey = function (code) {
    if (!this.active) return false;
    if (code === 10009 || code === 27) this.stop(true);
    return true;
  };
  Player.prototype.handleKeyUp = function () {};
  Player.prototype.resetHold = function () {};
  var context = {
    document: document, SOAP_CONFIG: {version: "test"}, SoapApi: Api, SoapPlayer: Player,
    innerHeight: 1080, scrollBy: function () {}, addEventListener: document.addEventListener,
    setTimeout: function (fn, delay) { var timer = {fn: fn, delay: delay, at: now + delay, active: true}; timers.push(timer); return timer; },
    clearTimeout: function (timer) { if (timer) timer.active = false; }, Date: {now: function () { return now; }},
    localStorage: {getItem: function (key) { return saved[key] || null; }, setItem: function (key, value) { if (options.writeError) throw new Error("Storage unavailable"); saved[key] = value; timeline.push({type: "write", key: key, value: value}); }, removeItem: function (key) { delete saved[key]; }},
    tizen: {application: {getCurrentApplication: function () { return {exit: function () { exits++; }}; }}}
  };
  Object.defineProperty(context.localStorage, "length", {get: function () { return Object.keys(saved).length; }});
  context.localStorage.key = function (index) { return Object.keys(saved)[index]; };
  context.window = context;
  ["catalog.js", "store.js", "keyboard.js", "main.js"].forEach(function (file) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/" + file), "utf8"), context, {filename: file});
  });
  return {
    element: document.getElementById, document: document, requests: requests, saved: saved,
    toastCount: function () { return timers.filter(function (timer) { return timer.delay === 5500; }).length; },
    player: player, timeline: timeline, emit: emit,
    storage: context.localStorage,
    store: function () { return new context.SoapStore({storage: context.localStorage}); },
    advance: function (ms) {
      now += ms;
      timers.slice().forEach(function (timer) { if (timer.active && timer.at <= now) { timer.active = false; timer.fn(); } });
    },
    exits: function () { return exits; },
    key: function (code, properties) {
      var target = document.activeElement;
      var event = Object.assign({keyCode: code, prevented: false, preventDefault: function () { this.prevented = true; }}, properties);
      emit("keydown", event);
      if (!event.prevented && code === 13 && target.tagName === "BUTTON") target.click();
      return event;
    },
    release: function (code) { emit("keyup", {keyCode: code, preventDefault: function () {}}); },
    settle: function () { return new Promise(function (resolve) { setImmediate(resolve); }); },
    byFocus: function (key) { return query(root, "[data-focus]").find(function (item) { return item.getAttribute("data-focus") === key; }); }
  };
}

var SHOWS = [
  {sid: 1, title: "Beta", year: 2020, unwatched: 2, imdb_rating: 8},
  {sid: 2, title: "Alpha", year: 2024, unwatched: 1, imdb_rating: 9}
];

test("search focus is inert and one held OK cannot open, type, or apply twice", async function () {
  var h = harness();
  h.requests[0].resolve(SHOWS);
  await h.settle();
  h.element("search").focus();
  assert.equal(h.element("search-keyboard").hidden, true);
  h.key(13);
  h.key(13);
  h.key(13, {repeat: true});
  assert.equal(h.element("keyboard-query").textContent, "Введите название");
  h.release(13);
  h.key(65, {key: "Alpha".charAt(0)});
  h.element("keyboard-keys").querySelectorAll("button").find(function (button) { return button.textContent === "Найти"; }).focus();
  h.key(13);
  h.key(13);
  h.key(13, {repeat: true});
  assert.equal(h.element("search-keyboard").hidden, true);
  assert.equal(h.element("search").textContent, "A");
  assert.equal(h.document.activeElement, h.element("search"));
  assert.equal(h.requests.length, 1, "Applying a query filters the loaded catalog without a GET");
});

test("sorting stays local, saves the selected order and consumes held OK across menu close", async function () {
  var h = harness();
  h.requests[0].resolve(SHOWS);
  await h.settle();
  assert.equal(h.element("content").querySelector("button").getAttribute("data-focus"), "show-1");
  h.element("sort-my").focus();
  h.key(13);
  h.key(13);
  assert.equal(h.element("sort-menu").hidden, false);
  h.release(13);
  h.key(40);
  assert.equal(h.document.activeElement.getAttribute("data-focus"), "sort-option-title");
  h.key(13);
  h.key(13);
  h.key(13, {repeat: true});
  assert.equal(h.element("sort-menu").hidden, true);
  assert.equal(h.document.activeElement, h.element("sort-my"));
  assert.equal(h.saved["soap4samsung.my-sort"], "title");
  assert.equal(h.element("content").querySelector("button").getAttribute("data-focus"), "show-2");
  assert.equal(h.requests.length, 1);
});

test("catalog completion cannot steal focus from either open modal", async function () {
  for (var modal of ["search", "sort-my"]) {
    var h = harness();
    h.element(modal).focus();
    h.key(13);
    h.release(13);
    var selected = h.document.activeElement;
    h.requests[0].resolve(SHOWS);
    await h.settle();
    assert.equal(h.document.activeElement, selected, modal + " retains its selected key after GET completion");
    assert.equal(h.element("content").querySelectorAll("button").length, 0, "The modal defers background DOM replacement");
  }
});

test("auth failure closes either modal and releases its key handling before login", async function () {
  for (var modal of ["search", "sort-my"]) {
    var h = harness();
    h.element(modal).focus();
    h.key(13);
    h.release(13);
    h.requests[0].reject({status: 401});
    await h.settle();
    assert.equal(h.element("search-keyboard").hidden, true);
    assert.equal(h.element("sort-menu").hidden, true);
    assert.equal(h.element("login-view").hidden, false);
    assert.equal(h.document.activeElement, h.element("login-name"));
    assert.equal(h.key(37).prevented, false, "Hidden modal must not capture the login cursor key");
    assert.equal(h.saved["soap4samsung.token"], undefined);
  }
});

test("held Back closes either modal without exiting; distinct Back presses still exit", async function () {
  for (var modal of ["search", "sort-my"]) {
    var h = harness();
    h.requests[0].resolve(SHOWS);
    await h.settle();
    h.element(modal).focus();
    h.key(13);
    h.release(13);
    h.key(10009);
    h.key(10009);
    h.key(10009, {repeat: true});
    assert.equal(h.element("search-keyboard").hidden, true);
    assert.equal(h.element("sort-menu").hidden, true);
    assert.equal(h.exits(), 0, "Repeats after dismissing " + modal + " cannot exit the app");
    h.release(10009);
    h.key(10009);
    h.release(10009);
    h.key(10009);
    h.release(10009);
    h.key(10009);
    assert.equal(h.exits(), 1);
  }
});

function localData(prepare) {
  var data = {};
  var storage = {
    getItem: function (key) { return data[key] || null; },
    setItem: function (key, value) { data[key] = value; },
    removeItem: function (key) { delete data[key]; },
    key: function (index) { return Object.keys(data)[index]; }
  };
  Object.defineProperty(storage, "length", {get: function () { return Object.keys(data).length; }});
  prepare(new (require("../app/store.js"))({storage: storage, now: function () { return 100; }}));
  return data;
}
function episodes(count, season) {
  return Array.from({length: count}, function (_, index) {
    return {season: season || 1, episode: index + 1, title: "Episode " + (index + 1), watched: 0, files: [{eid: index + 1, translate: 4, quality: 3}]};
  });
}
function media(episode, season) { return {kind: "episode", sid: 1, season: season || 1, episode: episode}; }
async function openDetail(h, entries) {
  h.requests[0].resolve(SHOWS);
  await h.settle();
  h.byFocus("show-1").click();
  h.requests[h.requests.length - 1].resolve(entries || episodes(2));
  await h.settle();
}
async function startEpisode(h, number, playback) {
  h.byFocus("episode-1-" + (number || 1)).click();
  h.requests[h.requests.length - 1].resolve(playback || {stream: "https://video.invalid/synthetic", start_from: 0});
  await h.settle();
}
function pressBack(h) { h.key(10009); h.release(10009); }
function longPress(h, item) { item.focus(); h.key(13); h.advance(600); h.release(13); }

test("natural ends persist each immutable media before requesting and starting the next episode", async function () {
  var h = harness();
  await openDetail(h, episodes(2));
  await startEpisode(h);
  h.player.checkpoint = {positionMs: 1200000, durationMs: 1200000, playedSinceSeekMs: 40000};
  h.player.stop(true, undefined, "ended");
  assert.equal(h.store().get(media(1)).status, "watched", "Save completes synchronously before the next playback response");
  assert.equal(h.requests[h.requests.length - 1].args.file.eid, 2);
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/two", start_from: 50});
  await h.settle();
  h.player.checkpoint = {positionMs: 1000000, durationMs: 1200000, playedSinceSeekMs: 40000};
  h.player.stop(true, undefined, "ended");
  assert.equal(h.store().get(media(2)).status, "watched");
  assert.equal(h.player.starts.length, 2, "The last episode cannot cross into another season");
  var writes = h.timeline.filter(function (entry) { return entry.type === "write" && entry.key === "soap4samsung.local.show.1"; });
  var mark = writes.find(function (entry) { return JSON.parse(entry.value).episodes["1:1"]; });
  var secondStart = h.timeline.filter(function (entry) { return entry.type === "start"; })[1];
  assert.ok(h.timeline.indexOf(mark) < h.timeline.indexOf(secondStart));
  assert.equal(h.element("content").querySelectorAll(".episode-status").filter(function (item) { return item.textContent === "✓"; }).length, 2);
});

test("Back, Home and player errors save confirmed positions without auto advance", async function () {
  for (var reason of ["back", "home", "error"]) {
    var h = harness();
    await openDetail(h);
    await startEpisode(h);
    h.player.checkpoint = {positionMs: 125000, durationMs: 1200000, playedSinceSeekMs: 15000};
    if (reason === "back") pressBack(h);
    if (reason === "home") { h.document.hidden = true; h.emit("visibilitychange", {}); }
    if (reason === "error") h.player.stop(true, "Synthetic error");
    assert.equal(h.store().get(media(1)).positionMs, 125000, reason);
    assert.equal(h.store().get(media(1)).status, "progress");
    assert.equal(h.player.starts.length, 1);
    assert.equal(h.requests.filter(function (request) { return request.kind === "play"; }).length, 1);
  }
});

test("pagehide and login teardown checkpoint before non-notifying stop", async function () {
  for (var reason of ["pagehide", "login"]) {
    var h = harness();
    await openDetail(h);
    await startEpisode(h);
    h.player.checkpoint = {positionMs: 80000, durationMs: 1200000, playedSinceSeekMs: 10000};
    if (reason === "pagehide") h.emit("pagehide", {});
    else {
      h.element("nav-all").click();
      h.requests[h.requests.length - 1].reject({status: 401});
      await h.settle();
      assert.equal(h.element("login-view").hidden, false);
    }
    assert.equal(h.store().get(media(1)).positionMs, 80000);
    assert.equal(h.timeline[h.timeline.length - 1].type, "stop");
    assert.equal(h.player.starts.length, 1);
  }
});

test("progress callbacks and local resume override API offsets, restart remains zero", async function () {
  var h = harness({saved: localData(function (store) {
    store.saveProgress(media(2), {positionMs: 125000, durationMs: 1200000}, SHOWS[0]);
  })});
  await openDetail(h);
  assert.equal(h.document.activeElement.getAttribute("data-focus"), "show-play");
  h.byFocus("show-play").click();
  assert.equal(h.requests[h.requests.length - 1].args.file.eid, 2, "Primary action chooses the latest unfinished episode");
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/resume", start_from: 5});
  await h.settle();
  assert.equal(h.player.starts[0].start_from, 120);
  h.player.options.onProgress({positionMs: 180000, durationMs: 1200000, playedSinceSeekMs: 20000});
  assert.equal(h.store().get(media(2)).positionMs, 180000);
  h.player.checkpoint = {positionMs: 180000, durationMs: 1200000, playedSinceSeekMs: 20000};
  pressBack(h);
  longPress(h, h.byFocus("episode-1-2"));
  h.key(13); h.release(13);
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/restart", start_from: 500});
  await h.settle();
  assert.equal(h.player.starts[1].start_from, 0);
});

test("auto advance applies resume and cancels stale playback responses after Back or Home", async function () {
  var h = harness({saved: localData(function (store) { store.saveProgress(media(2), {positionMs: 90000, durationMs: 1200000}, SHOWS[0]); })});
  await openDetail(h);
  await startEpisode(h, 1);
  h.player.stop(true, undefined, "ended");
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/next", start_from: 1});
  await h.settle();
  assert.equal(h.player.starts[1].start_from, 85);
  pressBack(h);
  h.byFocus("episode-1-1").click();
  var pending = h.requests[h.requests.length - 1];
  pressBack(h);
  pending.resolve({stream: "https://video.invalid/late"});
  await h.settle();
  assert.equal(h.player.starts.length, 2);
});

test("bulk and single undo are local and override service watched flags", async function () {
  var h = harness();
  var entries = episodes(2); entries[0].watched = 1;
  await openDetail(h, entries);
  var requestCount = h.requests.length;
  longPress(h, h.byFocus("episode-1-1"));
  h.key(40); h.key(13); h.release(13);
  assert.equal(h.store().effectiveWatched(media(1), 1), false);
  assert.equal(h.store().adjustedUnwatched(SHOWS[0]), 3);
  assert.equal(h.byFocus("episode-1-1").querySelector(".episode-status").textContent, "▶");
  h.byFocus("show-more").click();
  h.element("mark-season").click();
  assert.equal(h.store().effectiveWatched(media(1), 1), true);
  assert.equal(h.store().effectiveWatched(media(2), 0), true);
  h.element("mark-season").click();
  assert.equal(h.store().effectiveWatched(media(1), 1), false);
  assert.equal(h.store().effectiveWatched(media(2), 0), false);
  h.element("mark-show").click();
  assert.equal(h.store().effectiveWatched(media(2), 0), true);
  assert.equal(h.requests.length, requestCount);
  pressBack(h);
  assert.equal(h.document.activeElement.getAttribute("data-focus"), "show-more");
});

test("favorites snapshots render immediately, refresh preserves focus and import runs only once", async function () {
  var initial = localData(function (store) { store.importFavoritesOnce(SHOWS); store.toggleFavorite("show", SHOWS[1]); });
  var h = harness({saved: initial});
  assert.ok(h.byFocus("show-1"));
  assert.equal(h.byFocus("show-2"), undefined);
  h.byFocus("show-1").focus();
  h.requests[0].resolve([Object.assign({}, SHOWS[0], {year: 2025}), SHOWS[1]]);
  await h.settle();
  assert.equal(h.document.activeElement.getAttribute("data-focus"), "show-1");
  assert.equal(h.store().favorites("show").length, 1);
  assert.equal(h.store().favorites("show")[0].year, 2025);
  h.element("nav-my").click();
  h.element("nav-my").focus();
  h.requests[h.requests.length - 1].reject({status: 0});
  await h.settle();
  assert.equal(h.document.activeElement, h.element("nav-my"));
  assert.ok(h.byFocus("show-1"));
});

test("favorites refresh defers DOM replacement while a modal is open and flushes on close", async function () {
  for (var modal of ["sort-my", "search"]) {
    var h = harness({saved: localData(function (store) { store.importFavoritesOnce(SHOWS); })});
    var card = h.byFocus("show-1");
    h.element(modal).focus(); h.key(13); h.release(13);
    var focused = h.document.activeElement;
    h.requests[0].resolve(SHOWS);
    await h.settle();
    assert.equal(h.document.activeElement, focused);
    assert.equal(h.byFocus("show-1"), card, "No background DOM replacement under the modal");
    pressBack(h);
    assert.equal(h.document.activeElement, h.element(modal));
    assert.notEqual(h.byFocus("show-1"), card, "Deferred data renders after modal close");
  }
});

test("catalog loads on entry, local favorites mutations and movie filter do not GET", async function () {
  var h = harness();
  h.requests[0].resolve(SHOWS); await h.settle();
  h.element("nav-movies").click();
  h.requests[h.requests.length - 1].resolve([{id: 4, title: "Movie", year: 2025, watched: 1}]); await h.settle();
  var count = h.requests.length;
  longPress(h, h.byFocus("movie-4")); h.key(13); h.release(13);
  assert.equal(h.store().favorites("movie").length, 1);
  assert.equal(h.store().favorites("show").length, 2);
  h.element("movies-filter").click();
  assert.equal(h.saved["soap4samsung.movies-filter"], "favorites");
  assert.ok(h.byFocus("movie-4"));
  assert.equal(h.requests.length, count);
  h.element("nav-my").click();
  assert.equal(h.element("content").querySelectorAll(".show-card").length, 2);
  assert.equal(h.byFocus("movie-4"), undefined);
});

test("movies resume, restart and local watched undo share the store", async function () {
  var h = harness({saved: localData(function (store) { store.saveProgress({kind: "movie", id: 4}, {positionMs: 100000, durationMs: 1000000}, {id: 4, title: "Movie"}); })});
  h.requests[0].resolve(SHOWS); await h.settle();
  h.element("nav-movies").click();
  h.requests[h.requests.length - 1].resolve([{id: 4, title: "Movie", watched: 1}]); await h.settle();
  h.byFocus("movie-4").click();
  h.byFocus("movie-play").click();
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/movie", start_from: 0}); await h.settle();
  assert.equal(h.player.starts[0].start_from, 95);
  h.player.checkpoint = {positionMs: 200000, durationMs: 1000000}; pressBack(h);
  h.byFocus("movie-watched").click();
  assert.equal(h.store().effectiveWatched({kind: "movie", id: 4}, 1), false);
  h.byFocus("movie-play").click();
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/movie", start_from: 0}); await h.settle();
  h.player.checkpoint = {positionMs: 200000, durationMs: 1000000}; pressBack(h);
  h.byFocus("movie-restart").click();
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/movie", start_from: 99}); await h.settle();
  assert.equal(h.player.starts[2].start_from, 0);
  h.player.stop(true, undefined, "ended");
  assert.equal(h.player.starts.length, 3);
  assert.equal(h.store().get({kind: "movie", id: 4}).status, "watched");
});

test("grid arrows retain columns, page turns are limited to 250ms and Back has two stages", async function () {
  var h = harness();
  h.requests[0].resolve(Array.from({length: 70}, function (_, index) { return {sid: index + 1, title: "Show " + (index + 1)}; })); await h.settle();
  var grid = h.element("content").querySelector(".show-grid");
  assert.equal(grid.children.length, 21);
  grid.children[17].focus(); h.key(40);
  assert.equal(h.document.activeElement.getAttribute("data-grid-index"), "3");
  assert.equal(h.element("pagination").textContent, "‹2 / 4›");
  h.key(38, {repeat: true});
  assert.equal(h.element("pagination").textContent, "‹2 / 4›");
  h.advance(250); h.key(38, {repeat: true});
  assert.equal(h.element("pagination").textContent, "‹1 / 4›");
  assert.equal(h.document.activeElement.getAttribute("data-grid-index"), "17");
  pressBack(h);
  assert.equal(h.document.activeElement, h.element("nav-my"));
  assert.equal(h.exits(), 0);
  pressBack(h);
  assert.equal(h.exits(), 0, "Second Back shows the exit prompt");
  pressBack(h); assert.equal(h.exits(), 1);
});

test("episode paging and repeated show entry retain season, page, section and card focus", async function () {
  var h = harness();
  await openDetail(h, episodes(18).concat(episodes(18, 2)));
  h.byFocus("season-2").click();
  h.byFocus("episode-2-14").focus(); h.key(40);
  assert.equal(h.document.activeElement.getAttribute("data-focus"), "episode-2-18");
  pressBack(h);
  assert.equal(h.document.activeElement.getAttribute("data-focus"), "show-1");
  h.byFocus("show-1").click();
  h.requests[h.requests.length - 1].resolve(episodes(18).concat(episodes(18, 2))); await h.settle();
  assert.ok(h.byFocus("episode-2-17"));
  assert.equal(h.byFocus("episode-2-1"), undefined);
});

test("short OK clicks once, long OK opens only the context and window blur cancels it", async function () {
  var h = harness();
  h.requests[0].resolve(SHOWS); await h.settle();
  var card = h.byFocus("show-1"); card.focus();
  h.key(13); h.key(13); h.key(13, {repeat: true});
  assert.equal(h.requests.length, 1);
  h.release(13); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(episodes(2)); await h.settle();
  var episode = h.byFocus("episode-1-1"); episode.focus();
  h.key(13); h.advance(599);
  assert.equal(h.element("sort-menu").hidden, true);
  h.advance(1); h.key(13, {repeat: true}); h.release(13);
  assert.equal(h.element("sort-menu").hidden, false);
  assert.equal(h.requests.length, 2);
  pressBack(h);
  assert.equal(h.document.activeElement, episode);
  h.key(13); h.emit("blur", {}); h.advance(1000); h.release(13);
  assert.equal(h.element("sort-menu").hidden, true);
  assert.equal(h.requests.length, 2);
  episode.click(); assert.equal(h.requests.length, 3, "Mouse click still plays normally");
});

test("settings have no GET, confirmation cancels on focus departure, reset retains token and sort, logout retains data", async function () {
  var h = harness({saved: Object.assign(localData(function (store) { store.importFavoritesOnce(SHOWS); }), {"soap4samsung.my-sort": "year"})});
  h.element("nav-settings").click();
  assert.equal(h.requests.length, 1);
  var reset = h.byFocus("settings-reset"); reset.focus();
  h.key(13); h.key(13, {repeat: true}); h.release(13);
  assert.equal(h.store().favorites("show").length, 2);
  h.byFocus("settings-refresh").focus(); reset.focus(); h.key(13); h.release(13);
  assert.equal(h.store().favorites("show").length, 2);
  h.key(13); h.release(13);
  assert.equal(h.store().favorites("show").length, 0);
  assert.equal(h.saved["soap4samsung.token"], "synthetic-session");
  assert.equal(h.saved["soap4samsung.my-sort"], "year");
  h.store().toggleFavorite("movie", {id: 9, title: "Preserved"});
  var logout = h.byFocus("settings-logout"); logout.focus(); h.key(13); h.release(13);
  assert.equal(h.element("login-view").hidden, true);
  h.key(13); h.release(13);
  assert.equal(h.element("login-view").hidden, false);
  assert.equal(h.saved["soap4samsung.token"], undefined);
  assert.equal(h.store().favorites("movie").length, 1);
  assert.equal(h.requests.length, 1);
});

test("Continue uses fourteen cards on its first page, twenty-one afterwards and opens the next episode after completion", async function () {
  var shows = Array.from({length: 40}, function (_, index) { return {sid: index + 1, title: "Show " + (index + 1), unwatched: 2}; });
  var h = harness({saved: localData(function (store) {
    store.importFavoritesOnce(shows);
    store.setWatched(media(1), true, shows[0]);
  })});
  assert.equal(h.element("content").querySelector(".show-grid").children.length, 14);
  var continued = h.byFocus("continue-show-1");
  assert.ok(continued);
  assert.match(continued.textContent, /После S1E1/);
  h.element("content").querySelector(".show-grid").children[10].focus(); h.key(40);
  assert.equal(h.element("content").querySelector(".show-grid").children.length, 21);
  assert.equal(h.element("content").querySelectorAll(".continue-card").length, 0);
  h.advance(250); h.key(38);
  h.byFocus("continue-show-1").click();
  h.requests[h.requests.length - 1].resolve(episodes(3)); await h.settle();
  assert.equal(h.document.activeElement.getAttribute("data-focus"), "episode-1-2");
  assert.match(h.byFocus("show-play").textContent, /S1E2/);
});

test("ordinary show entry prioritizes unfinished progress and completed shows leave Continue", async function () {
  var h = harness({saved: localData(function (store) {
    store.importFavoritesOnce(SHOWS);
    store.saveProgress(media(1, 2), {positionMs: 90000, durationMs: 1200000}, SHOWS[0]);
    store.setWatched(media(1), true, SHOWS[0]);
    store.setEpisodesWatched(2, episodes(1), true, {sid: 2, title: "Finished", unwatched: 0});
  })});
  assert.equal(h.byFocus("continue-show-2"), undefined);
  await openDetail(h, episodes(3).concat(episodes(2, 2)));
  assert.ok(h.byFocus("episode-2-1"));
  assert.match(h.byFocus("show-play").textContent, /S2E1/);
});

test("cache refresh and local reset invalidate pending catalogs instead of accepting their late data", async function () {
  for (var action of ["settings-refresh", "settings-reset"]) {
    var h = harness();
    h.element("nav-settings").click();
    h.byFocus(action).click();
    if (action === "settings-reset") h.byFocus(action).click();
    h.requests[0].resolve(SHOWS); await h.settle();
    assert.equal(h.store().favorites("show").length, 0, "Late background import cannot undo the settings action");
    h.element("nav-my").click();
    assert.equal(h.element("content").querySelectorAll(".show-card").length, 0);
    h.requests[h.requests.length - 1].resolve(SHOWS); await h.settle();
    assert.equal(h.store().favorites("show").length, 2);
  }
});

test("storage failures notify only once per launch and do not interrupt playback", async function () {
  var h = harness({writeError: true});
  h.requests[0].resolve(SHOWS); await h.settle();
  assert.equal(h.toastCount(), 1);
  h.element("nav-all").click();
  h.requests[h.requests.length - 1].resolve(SHOWS); await h.settle();
  h.byFocus("show-1").click();
  h.requests[h.requests.length - 1].resolve(episodes(2)); await h.settle();
  await startEpisode(h);
  h.player.options.onProgress({positionMs: 90000, durationMs: 1200000});
  assert.equal(h.toastCount(), 1);
  assert.equal(h.player.active, true);
});

test("pagehide cancels a pending playback response", async function () {
  var h = harness(); await openDetail(h);
  h.byFocus("episode-1-1").click();
  h.emit("pagehide", {});
  h.requests[h.requests.length - 1].resolve({stream: "https://video.invalid/late"}); await h.settle();
  assert.equal(h.player.starts.length, 0);
});

test("context selection consumes held OK until release, including remotes without repeat flags", async function () {
  var h = harness(); h.requests[0].resolve(SHOWS); await h.settle();
  longPress(h, h.byFocus("show-1"));
  h.key(13); h.key(13); h.advance(600);
  assert.equal(h.element("sort-menu").hidden, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.store().isFavorite("show", 1), false);
  h.release(13);
});

test("finished shows do not take Continue slots from an older unfinished show", function () {
  var shows = Array.from({length: 8}, function (_, index) { return {sid: index + 1, title: "Show " + (index + 1), unwatched: 0}; });
  var h = harness({saved: localData(function (store) {
    store.importFavoritesOnce(shows);
    store.saveProgress(media(1, 2), {positionMs: 90000, durationMs: 1200000}, shows[0]);
    shows.slice(1).forEach(function (show) { store.setEpisodesWatched(show.sid, episodes(1), true, show); });
  })});
  assert.ok(h.byFocus("continue-show-1"));
});
