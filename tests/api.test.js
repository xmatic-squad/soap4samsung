"use strict";
var assert = require("node:assert/strict");
var crypto = require("node:crypto");
var test = require("node:test");
var SoapApi = require("../app/api.js");

function fakeTransport(t, responses) {
  var previous = global.XMLHttpRequest;
  var requests = [];
  global.XMLHttpRequest = function () {
    this.headers = {};
    requests.push(this);
  };
  global.XMLHttpRequest.prototype.open = function (method, url, async) {
    this.method = method;
    this.url = url;
    this.async = async;
  };
  global.XMLHttpRequest.prototype.setRequestHeader = function (key, value) { this.headers[key] = value; };
  global.XMLHttpRequest.prototype.send = function (body) {
    this.body = body;
    var next = responses.shift();
    assert.ok(next, "Unexpected API request");
    this.status = next.status === undefined ? 200 : next.status;
    this.responseText = next.raw === undefined ? JSON.stringify(next.body) : next.raw;
    if (next.throw) throw new Error(next.throw);
    if (next.event) this[next.event]();
    else this.onload();
  };
  t.after(function () {
    global.XMLHttpRequest = previous;
    assert.equal(responses.length, 0, "Not all expected requests were sent");
  });
  return requests;
}

test("MD5 follows standard vectors and UTF-8, including multi-block padding", function () {
  var known = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"]
  ];
  known.forEach(function (vector) { assert.equal(SoapApi.md5(vector[0]), vector[1]); });
  ["Русский сериал 📺", "unpaired\ud800surrogate", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(1000)].forEach(function (value) {
    assert.equal(SoapApi.md5(value), crypto.createHash("md5").update(value, "utf8").digest("hex"));
  });
});

test("Russian selection prefers dubbed 4K, then FullHD, 720p and SD", function () {
  function file(eid, quality, translate) { return {eid: eid, hash: "fixture-hash", quality: quality, translate: translate}; }
  var original = file("orig", 3, 1);
  var subtitles = file("subs", 3, 3);
  var russianSd = file("sd", "1", 4);
  var russianHd = file("hd", "2", "4");
  var russianFullHd = file("full", "3", 4);
  var russian4k = file("4k", "4", 4);
  assert.equal(SoapApi.chooseRussianFile([original, subtitles]), null);
  assert.equal(SoapApi.chooseRussianFile([russian4k, original, russianFullHd, russianHd]), russian4k);
  assert.equal(SoapApi.chooseRussianFile([russianSd, russianHd, russianFullHd, russian4k]), russian4k);
  assert.equal(SoapApi.chooseRussianFile([original, russianHd, russianSd, russianFullHd]), russianFullHd);
  assert.equal(SoapApi.chooseRussianFile([file("original4k", 4, 1), russianSd, russianHd]), russianHd);
  assert.equal(SoapApi.chooseRussianFile([original, russianSd]), russianSd);
  assert.equal(SoapApi.chooseRussianFile([original, russian4k]), russian4k);
  assert.equal(SoapApi.chooseRussianFile([null, {translate: 4}, file("unknown", "8", 4)]), null);
  assert.equal(SoapApi.chooseRussianFile(null), null);
});

test("normalizes the observed flat response, preserves files and attaches season covers", function () {
  var files = [{eid: "123", hash: "fixture", quality: "3", translate: 4}];
  var cover = {season: "2", small: "https://example.invalid/cover.jpg", big: "https://example.invalid/cover-big.jpg"};
  var response = {episodes: [
    {title_ru: "Финал", season: "2", episode: "10", watched: 1, start_from: 120, files: files},
    {title_ru: "Начало", season: "1", episode: "1", files: []},
    {title_ru: "Вторая", season: "2", episode: "2"},
    {title_ru: "Спецвыпуск", season: "0", episode: "1", files: []}
  ], covers: [cover]};
  var output = new SoapApi().normalizeEpisodes(response);
  assert.deepEqual(output.map(function (e) { return e.season + ":" + e.episode; }), ["0:1", "1:1", "2:2", "2:10"]);
  assert.equal(output[3].covers, cover);
  assert.deepEqual(output[3].files, files);
  assert.equal(output[3].start_from, 120);
  assert.equal(output[3].watched, 1);
  assert.deepEqual(output[2].files, []);
  assert.equal(response.episodes[0].covers, undefined, "Source objects are not mutated");
  assert.notEqual(output[3].files, files);
  assert.deepEqual(SoapApi.normalizeEpisodes({episodes: []}), []);
  assert.deepEqual(SoapApi.normalizeEpisodes(null), []);
  assert.deepEqual(SoapApi.normalizeEpisodes([null, {season: "1", episode: "1", files: []}]).length, 1);
});

test("login sends an encoded form with cookies, then authenticates catalog and playback requests", async function (t) {
  var token = "fixture-session-token";
  var my = [{sid: "425", title_ru: "Сериал", covers: {small: "https://example.invalid/cover.jpg"}}];
  var all = [{sid: "426", title_ru: "Другой сериал"}];
  var episodes = {episodes: [{season: "1", episode: "1", files: []}], covers: []};
  var playback = {ok: 1, stream: "https://example.invalid/video.mp4?secret=fixture", start_from: 0};
  var requests = fakeTransport(t, [
    {body: {ok: 1, token: token}}, {raw: '<form action="/logout" method="post"></form>'},
    {body: {logged: 1}}, {body: my}, {body: all}, {body: episodes}, {body: playback}
  ]);
  var api = new SoapApi({baseUrl: "/api/", token: "old-token"});
  await api.login(" user+name ", "p&= пар оль");
  assert.equal(api.getToken(), token);
  assert.equal(requests[0].url, "/api/auth/");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers["X-API-TOKEN"], undefined);
  assert.equal(requests[0].body, "login=user%2Bname&password=p%26%3D%20%D0%BF%D0%B0%D1%80%20%D0%BE%D0%BB%D1%8C");
  assert.equal(requests[1].url, "/site/login/");
  assert.equal(requests[1].body, requests[0].body);
  assert.equal(requests[1].headers["X-API-TOKEN"], undefined, "Website login uses its own cookie, not the API token");
  await api.checkAuth();
  assert.deepEqual(await api.getMyShows(), my);
  assert.deepEqual(await api.getAllShows(), all);
  assert.deepEqual(await api.getEpisodes("425"), episodes);
  assert.deepEqual(await api.getPlayback("425", {eid: "123", hash: "source-hash", translate: 4, quality: 3}), playback);
  requests.forEach(function (request, i) {
    assert.equal(request.withCredentials, true, "Session cookie is required by Soap4me");
    assert.equal(request.timeout, 20000);
    assert.equal(request.async, true);
    if (i > 1) assert.equal(request.headers["X-API-TOKEN"], token);
  });
  assert.deepEqual(requests.slice(2).map(function (r) { return r.url; }), ["/api/auth/check/", "/api/soap/my/", "/api/soap/", "/api/episodes/425/", "/api/play/episode/123/"]);
  var expectedHash = crypto.createHash("md5").update(token + "123425source-hash").digest("hex");
  assert.equal(requests[6].body, "eid=123&hash=" + expectedHash);
  assert.equal(requests[6].body.includes(token), false);
});

test("authentication failures are actionable and never expose response secrets", async function (t) {
  var requests = fakeTransport(t, [
    {status: 401, body: {ok: 0, code: 401, msg: "secret-token https://example.invalid/private"}},
    {body: {ok: 0, code: 401, msg: "secret-token"}},
    {body: {logged: 0, loged: 0}},
    {body: {ok: 0, msg: "secret-password"}}
  ]);
  var api = new SoapApi({token: "fixture"});
  for (var action of [function () { return api.getMyShows(); }, function () { return api.getAllShows(); }, function () { return api.checkAuth(); }, function () { return api.login("name", "secret-password"); }]) {
    await assert.rejects(action, function (error) {
      assert.equal(error.name, "SoapApiError");
      assert.equal(error.code, "AUTH_REQUIRED");
      assert.doesNotMatch(error.message, /secret|example\.invalid/);
      return true;
    });
  }
  assert.equal(api.getToken(), "fixture", "Failed login must not store an invalid token");
  assert.deepEqual(requests.map(function (request) { return request.url; }), [
    "https://api.soap4youand.me/v2/soap/my/",
    "https://api.soap4youand.me/v2/soap/",
    "https://api.soap4youand.me/v2/auth/check/",
    "https://api.soap4youand.me/v2/auth/"
  ]);
});

test("network, timeout, HTTP and malformed responses produce sanitized errors", async function (t) {
  fakeTransport(t, [
    {event: "onerror"}, {event: "ontimeout"},
    {status: 503, raw: "https://example.invalid/private?token=secret"},
    {raw: "not json secret"}, {body: {unexpected: "secret"}},
    {body: {ok: 0, msg: "secret"}},
    {throw: "Browser error with token=secret"}
  ]);
  var api = new SoapApi({token: "fixture"});
  for (var code of ["NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "INVALID_RESPONSE", "INVALID_RESPONSE", "API_ERROR", "NETWORK_ERROR"]) {
    await assert.rejects(function () { return api.getMyShows(); }, function (error) {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret|example\.invalid/);
      return true;
    });
  }
});

test("invalid inputs and missing session are rejected before a network request", async function (t) {
  var requests = fakeTransport(t, []);
  var api = new SoapApi();
  await assert.rejects(api.getMyShows(), {code: "AUTH_REQUIRED", status: 401});
  await assert.rejects(api.login("", "password"), {code: "BAD_INPUT"});
  await assert.rejects(api.getEpisodes(null), {code: "BAD_INPUT"});
  await assert.rejects(api.getPlayback("425", {}), {code: "BAD_INPUT"});
  assert.equal(requests.length, 0);
});

test("bulk watched marks target episodes, preserve special season zero and require explicit success", async function (t) {
  var requests = fakeTransport(t, [{body: {ok: 1}}, {body: {ok: "1"}}, {body: {ok: 1}}]);
  var api = new SoapApi({baseUrl: "/api/v2", token: "fixture-session"});
  assert.deepEqual(await api.markShowWatched("425"), {ok: 1});
  assert.deepEqual(await api.markSeasonWatched("425", "2"), {ok: "1"});
  assert.deepEqual(await api.markSeasonWatched(425, 0), {ok: 1});
  assert.deepEqual(requests.map(function (request) {
    return {method: request.method, url: request.url, body: request.body};
  }), [
    {method: "POST", url: "/api/v2/episodes/watch/full/425/", body: "sid=425"},
    {method: "POST", url: "/api/v2/episodes/watch/full/425/2/", body: "sid=425&season=2"},
    {method: "POST", url: "/api/v2/episodes/watch/full/425/0/", body: "sid=425&season=0"}
  ]);
  requests.forEach(function (request) {
    assert.equal(request.headers["X-API-TOKEN"], "fixture-session");
    assert.equal(request.withCredentials, true);
    assert.match(request.headers["Content-Type"], /^application\/x-www-form-urlencoded/);
  });
});

test("bulk marks reject ambiguous success, service failure and expired authentication", async function (t) {
  fakeTransport(t, [
    {body: {message: "done"}}, {body: {ok: 0, msg: "private-server-detail"}},
    {status: 401, body: {ok: 0, code: 401}}, {body: []}
  ]);
  var api = new SoapApi({token: "fixture-session"});
  await assert.rejects(api.markShowWatched(425), {code: "INVALID_RESPONSE"});
  await assert.rejects(api.markSeasonWatched(425, 2), function (error) {
    assert.equal(error.code, "API_ERROR");
    assert.doesNotMatch(error.message, /private-server-detail/);
    return true;
  });
  await assert.rejects(api.markShowWatched(425), {code: "AUTH_REQUIRED"});
  await assert.rejects(api.markSeasonWatched(425, 2), {code: "INVALID_RESPONSE"});
});

test("bulk marks reject unsafe or missing identifiers without sending mutations", async function (t) {
  var requests = fakeTransport(t, []);
  var api = new SoapApi({token: "fixture-session"});
  for (var sid of [null, undefined, "", 0, -1, 1.5, "1/2", "1?sid=2", true, {}, 1e20]) {
    await assert.rejects(api.markShowWatched(sid), {code: "BAD_INPUT"});
    await assert.rejects(api.markSeasonWatched(sid, 1), {code: "BAD_INPUT"});
  }
  for (var season of [null, undefined, "", -1, 0.5, "2/3", false, {}]) {
    await assert.rejects(api.markSeasonWatched(425, season), {code: "BAD_INPUT"});
  }
  api.setToken("");
  await assert.rejects(api.markShowWatched(425), {code: "AUTH_REQUIRED"});
  assert.equal(requests.length, 0);
});

function moviePage(mid, stream) {
  return '<form action="/logout" method="post" id="exit"></form><script>' +
    'window.movieFixtureExecuted = true; cache["movie_player_' + mid + '"] = new Playerjs({' +
    'id:"movie_player_' + mid + '", file:' + JSON.stringify(stream) + ', title:"Фильм (2025)",' +
    'hlsconfig:{debug:false,maxBufferSize:60 * 1000 * 1000}});</script>';
}

var russianManifest = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Русский",LANGUAGE="ru",DEFAULT=YES,URI="index-f1-a1.m3u8"\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x800,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"\nindex-f5-v1.m3u8\n';

test("movies use their own IDs, fresh authenticated website pages and credential-free Russian HLS", async function (t) {
  var firstStream = "https://cdn-test.soap4youand.me/hls/fixture-one/master.m3u8";
  var secondStream = "https://cdn-test.soap4youand.me/hls/fixture-two/master.m3u8";
  var movies = [{id: "298", title: "Фильм", year: "2025", covers: {small: "/cover.jpg"}}];
  var requests = fakeTransport(t, [
    {body: movies}, {raw: moviePage(298, firstStream)}, {raw: russianManifest}, {raw: russianManifest},
    {raw: moviePage(298, secondStream)}, {raw: russianManifest}, {raw: russianManifest}
  ]);
  var api = new SoapApi({token: "fixture-token", siteBaseUrl: "/site"});
  assert.deepEqual(await api.getMovies(), movies);
  assert.deepEqual(await api.getMoviePlayback("298"), {ok: 1, stream: firstStream.replace("master.m3u8", "master-f5-v1-f1-a1.m3u8"), start_from: 0, title: "Фильм (2025)", audioLanguage: "ru", hlsBitrate: 8000000});
  assert.equal((await api.getMoviePlayback(298)).stream, secondStream.replace("master.m3u8", "master-f5-v1-f1-a1.m3u8"), "Each play fetches a new signed address");
  assert.equal(global.movieFixtureExecuted, undefined, "Website HTML and JavaScript must never execute");
  assert.equal(requests[0].url, "https://api.soap4youand.me/v2/movies/");
  [1, 4].forEach(function (i) {
    assert.equal(requests[i].url, "/site/movies/298/");
    assert.equal(requests[i].withCredentials, true);
    assert.equal(requests[i].headers["X-API-TOKEN"], undefined);
  });
  [2, 3, 5, 6].forEach(function (i) {
    assert.equal(requests[i].withCredentials, false, "Do not send account cookies to the CDN");
    assert.equal(requests[i].headers["X-API-TOKEN"], undefined);
    assert.equal(requests[i].body, null);
  });
});

test("missing website session requests reauthentication while an unavailable movie does not", async function (t) {
  fakeTransport(t, [
    {raw: '<html><a href="/login/">Войти</a></html>'},
    {status: 403, raw: "private-details"},
    {raw: '<form action="/logout" method="post"></form><p>Нет видео</p>'}
  ]);
  var api = new SoapApi({token: "fixture-token"});
  await assert.rejects(api.getMoviePlayback(298), {code: "SITE_AUTH_REQUIRED"});
  await assert.rejects(api.getMoviePlayback(298), {code: "SITE_AUTH_REQUIRED"});
  await assert.rejects(api.getMoviePlayback(298), {code: "INVALID_RESPONSE"});
});

test("movie parsing accepts JSON escaping and refuses foreign hosts, unsafe schemes and wrong IDs", async function (t) {
  var escaped = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8").replace(/https:\/\//g, "https:\\/\\/");
  var invalidUrls = [
    "http://cdn-test.soap4youand.me/hls/fixture/master.m3u8",
    "https://cdn-test.soap4youand.me.attacker.invalid/hls/fixture/master.m3u8",
    "https://attacker.invalid/hls/fixture/master.m3u8",
    "https://user:private@cdn-test.soap4youand.me/hls/fixture/master.m3u8",
    "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8#private",
    "javascript:alert('private')",
    "https://cdn-test.soap4youand.me/private-not-a-manifest"
  ];
  var responses = [{raw: escaped}, {raw: russianManifest}, {raw: russianManifest}].concat(invalidUrls.map(function (url) { return {raw: moviePage(298, url)}; }));
  responses.push({raw: moviePage(299, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8")});
  var requests = fakeTransport(t, responses);
  var api = new SoapApi({token: "fixture-token"});
  assert.equal((await api.getMoviePlayback(298)).ok, 1);
  for (var i = 0; i < invalidUrls.length + 1; i++) {
    await assert.rejects(api.getMoviePlayback(298), function (error) {
      assert.equal(error.code, "INVALID_RESPONSE");
      assert.doesNotMatch(error.message, /private|attacker|javascript|https?:/);
      return true;
    });
  }
  assert.equal(requests.filter(function (request) { return !request.withCredentials; }).length, 2, "Invalid destinations are rejected before fetching");
});

test("Russian subtitles do not qualify as Russian audio and malformed manifests are rejected", async function (t) {
  var page = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8");
  fakeTransport(t, [
    {raw: page}, {raw: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",LANGUAGE="en",NAME="English"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="audio0",LANGUAGE="ru",NAME="Русский"\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"\nvideo.m3u8\n'},
    {raw: page}, {raw: '<html>private-stream-error</html>'}
  ]);
  var api = new SoapApi({token: "fixture-token"});
  await assert.rejects(api.getMoviePlayback(298), {code: "NO_RUSSIAN_AUDIO"});
  await assert.rejects(api.getMoviePlayback(298), {code: "INVALID_RESPONSE"});
});

test("website outage during companion login preserves a successful API session", async function (t) {
  var requests = fakeTransport(t, [
    {body: {ok: 1, token: "new-fixture-token"}}, {event: "ontimeout"}, {body: []}
  ]);
  var api = new SoapApi();
  await api.login("fixture-login", "fixture-password");
  assert.equal(api.getToken(), "new-fixture-token");
  assert.deepEqual(await api.getMyShows(), []);
  assert.equal(requests[1].url, "https://soap4youand.me/login/");
  assert.equal(requests[1].headers["X-API-TOKEN"], undefined);
});

test("invalid movie IDs cannot trigger website or CDN requests", async function (t) {
  var requests = fakeTransport(t, []);
  var api = new SoapApi({token: "fixture-token"});
  for (var mid of [null, undefined, "", 0, -1, 1.5, "298/../login", true, {}]) {
    await assert.rejects(api.getMoviePlayback(mid), {code: "BAD_INPUT"});
  }
  assert.equal(requests.length, 0);
});

function movieManifest(variants, media) {
  return '#EXTM3U\n' + (media || '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Русский, дубляж",LANGUAGE="ru",DEFAULT=YES,URI="index-f1-a1.m3u8"') + '\n' +
    variants.map(function (attributes) { return '#EXT-X-STREAM-INF:' + attributes + '\nindex-f5-v1.m3u8'; }).join('\n') + '\n';
}

test("mixed HLS selects the largest Russian AVC picture through 4K with bitrate tie-break", async function (t) {
  var stream = "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8";
  var manifest = movieManifest([
    'BANDWIDTH=26000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L150.B0,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=20000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=21000000,RESOLUTION=3840x2160,CODECS="avc3.640033,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=18000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=8000000,RESOLUTION=1920x1040,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=8235989,RESOLUTION=1920x1040,CODECS="avc3.640028,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=15000000,RESOLUTION=1920x1080,CODECS="hev1.1.6.L120.B0,mp4a.40.2",AUDIO="audio0"'
  ]);
  var filtered = movieManifest(['BANDWIDTH=21000000,RESOLUTION=3840x2160,CODECS="avc3.640033,mp4a.40.2",AUDIO="audio0"']);
  fakeTransport(t, [{raw: moviePage(12, stream)}, {raw: manifest}, {raw: filtered}]);
  var result = await new SoapApi({token: "fixture"}).getMoviePlayback(12);
  assert.equal(result.hlsBitrate, 21000000);
  assert.equal(result.stream, stream.replace("master.m3u8", "master-f5-v1-f1-a1.m3u8"), "Use a filtered master, including external Russian audio");
});

test("Russian audio must belong to the chosen variant's AUDIO group", async function (t) {
  var page = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8");
  var media = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ru-group",LANGUAGE="ru",NAME="Русский",URI="index-f1-a1.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="en-group",LANGUAGE="en",NAME="English",URI="index-f2-a1.m3u8"';
  var unrelated = movieManifest([
    'BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="en-group"'
  ], media);
  var matched = movieManifest([
    'BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="en-group"',
    'BANDWIDTH=3500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="ru-group"'
  ], media);
  var filtered = movieManifest(['BANDWIDTH=3500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="ru-group"'], media.split('\n')[0]);
  fakeTransport(t, [{raw: page}, {raw: unrelated}, {raw: page}, {raw: matched}, {raw: filtered}]);
  var api = new SoapApi({token: "fixture"});
  await assert.rejects(api.getMoviePlayback(298), {code: "NO_RUSSIAN_AUDIO"});
  assert.equal((await api.getMoviePlayback(298)).hlsBitrate, 3500000);
});

test("4K AVC stays preferred with lower resolutions available and ignores video above 4K", async function (t) {
  var page = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8");
  var higher = [
    'BANDWIDTH=30000000,RESOLUTION=7680x4320,CODECS="avc1.640034,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=19000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=17000000,RESOLUTION=3840x1604,CODECS="avc1.640033,mp4a.40.2",AUDIO="audio0"'
  ];
  var filtered = movieManifest([higher[1]]);
  fakeTransport(t, [
    {raw: page}, {raw: movieManifest(higher)}, {raw: filtered},
    {raw: page}, {raw: movieManifest(higher.concat('BANDWIDTH=1000000,RESOLUTION=720x390,CODECS="avc1.64001e,mp4a.40.2",AUDIO="audio0"'))}, {raw: filtered}
  ]);
  var api = new SoapApi({token: "fixture"});
  assert.equal((await api.getMoviePlayback(298)).hlsBitrate, 19000000);
  assert.equal((await api.getMoviePlayback(298)).hlsBitrate, 19000000);
});

test("movie quality falls back through FullHD, 720p and SD when higher Russian AVC is absent", async function (t) {
  var page = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8");
  var variants = [
    'BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=3500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=1000000,RESOLUTION=720x390,CODECS="avc1.64001e,mp4a.40.2",AUDIO="audio0"'
  ];
  fakeTransport(t, [
    {raw: page}, {raw: movieManifest(variants)}, {raw: movieManifest([variants[0]])},
    {raw: page}, {raw: movieManifest(variants.slice(1))}, {raw: movieManifest([variants[1]])},
    {raw: page}, {raw: movieManifest(variants.slice(2))}, {raw: movieManifest([variants[2]])}
  ]);
  var api = new SoapApi({token: "fixture"});
  assert.equal((await api.getMoviePlayback(298)).hlsBitrate, 8000000);
  assert.equal((await api.getMoviePlayback(298)).hlsBitrate, 3500000);
  assert.equal((await api.getMoviePlayback(298)).hlsBitrate, 1000000);
});

test("missing or unusable HLS video attributes yield a sanitized compatibility error", async function (t) {
  var page = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8");
  var bad = [
    'BANDWIDTH=8000000,RESOLUTION=1920x1080,AUDIO="audio0"',
    'BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.B0,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=8000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=0,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=8000000.5,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=8000000,RESOLUTION=0x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"'
  ].map(function (attributes) { return movieManifest([attributes]); });
  bad.push('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",LANGUAGE="ru"\n');
  bad.push(movieManifest(['BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"']).replace('\nindex-f5-v1.m3u8\n', '\n'));
  fakeTransport(t, bad.reduce(function (responses, manifest) { return responses.concat([{raw: page}, {raw: manifest}]); }, []));
  var api = new SoapApi({token: "fixture"});
  for (var i = 0; i < bad.length; i++) {
    await assert.rejects(api.getMoviePlayback(298), function (error) {
      assert.equal(error.code, "NO_COMPATIBLE_VIDEO");
      assert.doesNotMatch(error.message, /cdn-|fixture|m3u8|https?:/);
      return true;
    });
  }
});

test("filtered master uses selected child directory and selectors, retaining its query and verified bitrate", async function (t) {
  var websiteMaster = "https://cdn-test.soap4youand.me/hls/site-path/master.m3u8?old=fixture";
  var childBase = "https://cdn-test.soap4youand.me/signed-child-path/real%2Cfiles/";
  var childQuery = "?signed=fixture%2Fvalue&expires=123";
  var original = movieManifest([
    'BANDWIDTH=2500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'BANDWIDTH=15000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2",AUDIO="audio0"'
  ]).replace('URI="index-f1-a1.m3u8"', 'URI="' + childBase + 'index-f2-a1.m3u8' + childQuery + '"')
    .replace('index-f5-v1.m3u8', childBase + 'index-f3-v1.m3u8' + childQuery)
    .replace('index-f5-v1.m3u8', childBase + 'index-f7-v1.m3u8' + childQuery);
  var filtered = movieManifest(['BANDWIDTH=14999000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2",AUDIO="audio0"'])
    .replace('index-f1-a1.m3u8', 'index-f2-a1.m3u8' + childQuery)
    .replace('index-f5-v1.m3u8', 'index-f7-v1.m3u8' + childQuery);
  var requests = fakeTransport(t, [{raw: moviePage(298, websiteMaster)}, {raw: original}, {raw: filtered}]);
  var playback = await new SoapApi({token: "fixture-token"}).getMoviePlayback(298);
  var expected = childBase + "master-f7-v1-f2-a1.m3u8" + childQuery;
  assert.equal(playback.stream, expected);
  assert.equal(playback.hlsBitrate, 14999000, "Use bitrate from the revalidated filtered master");
  assert.deepEqual(requests.slice(1).map(function (request) { return request.url; }), [websiteMaster, expected]);
  requests.slice(1).forEach(function (request) {
    assert.equal(request.withCredentials, false);
    assert.equal(request.headers["X-API-TOKEN"], undefined);
  });
});

test("invalid or mismatched child destinations cannot trigger a filtered master request", async function (t) {
  var page = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8");
  var badChildren = [
    "https://attacker.invalid/hls/fixture/index-f5-v1.m3u8",
    "https://cdn-other.soap4youand.me/hls/fixture/index-f5-v1.m3u8",
    "http://cdn-test.soap4youand.me/hls/fixture/index-f5-v1.m3u8",
    "https://user:private@cdn-test.soap4youand.me/hls/fixture/index-f5-v1.m3u8",
    "https://cdn-test.soap4youand.me:8443/hls/fixture/index-f5-v1.m3u8",
    "index-f5-v1.m3u8#private",
    "index-f5-v1.m3u8?different=private",
    "/hls/other/index-f5-v1.m3u8",
    "index-f0-v1.m3u8",
    "index-f5-v0.m3u8",
    "index-f5-a1.m3u8",
    "index-f5-v1-extra.m3u8",
    "index-f5-v1%2Em3u8",
    "index-f5-v1.m3u8?private=\u0000",
    "sub\\index-f5-v1.m3u8"
  ].map(function (uri) { return russianManifest.replace('index-f5-v1.m3u8', uri); });
  badChildren.push(russianManifest.replace('URI="index-f1-a1.m3u8"', 'URI="https://attacker.invalid/index-f1-a1.m3u8"'));
  badChildren.push(russianManifest.replace(',URI="index-f1-a1.m3u8"', ''));
  var requests = fakeTransport(t, badChildren.reduce(function (responses, manifest) { return responses.concat([{raw: page}, {raw: manifest}]); }, []));
  var api = new SoapApi({token: "fixture-token"});
  for (var i = 0; i < badChildren.length; i++) {
    await assert.rejects(api.getMoviePlayback(298), function (error) {
      assert.equal(error.code, "INVALID_RESPONSE");
      assert.doesNotMatch(error.message, /private|attacker|cdn-|https?:|m3u8/);
      return true;
    });
  }
  assert.equal(requests.length, badChildren.length * 2, "Never request an unsafe synthesized URL");
});

test("filtered response rejects subtitles, extra video/audio and changed selection without falling back", async function (t) {
  var page = moviePage(298, "https://cdn-test.soap4youand.me/hls/fixture/master.m3u8");
  var bad = [
    russianManifest + '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="ru",URI="subtitles.m3u8"\n',
    russianManifest.replace('AUDIO="audio0"', 'AUDIO="audio0",SUBTITLES="subs"'),
    russianManifest + '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="hvc1.1.6.L120.B0",AUDIO="audio0"\nindex-f6-v1.m3u8\n',
    russianManifest + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio1",LANGUAGE="en",URI="index-f2-a1.m3u8"\n',
    russianManifest.replace('1920x800', '1280x720'),
    russianManifest.replace('avc1.640028', 'hvc1.1.6.L120.B0'),
    russianManifest.replace('LANGUAGE="ru"', 'LANGUAGE="en"'),
    russianManifest.replace('index-f5-v1.m3u8', 'index-f6-v1.m3u8'),
    russianManifest.replace('index-f1-a1.m3u8', 'index-f2-a1.m3u8'),
    russianManifest.replace('index-f5-v1.m3u8', 'https://attacker.invalid/hls/fixture/index-f5-v1.m3u8'),
    '<html>private CDN error</html>'
  ];
  var responses = bad.reduce(function (items, manifest) { return items.concat([{raw: page}, {raw: russianManifest}, {raw: manifest}]); }, []);
  responses.push({raw: page}, {raw: russianManifest}, {status: 404, raw: "private missing filtered master"});
  var requests = fakeTransport(t, responses);
  var api = new SoapApi({token: "fixture-token"});
  for (var i = 0; i < bad.length + 1; i++) {
    await assert.rejects(api.getMoviePlayback(298), function (error) {
      assert.ok(["NO_COMPATIBLE_VIDEO", "NO_RUSSIAN_AUDIO", "INVALID_RESPONSE", "HTTP_ERROR"].includes(error.code));
      assert.doesNotMatch(error.message, /private|attacker|cdn-|https?:|m3u8/);
      return true;
    });
  }
  assert.equal(requests.length, (bad.length + 1) * 3, "Never retry the original crash-prone master");
});
