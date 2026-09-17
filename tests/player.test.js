"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var test = require("node:test");
var vm = require("node:vm");

// Model asynchronous AVPlay callbacks and its documented restriction that no
// other AVPlay call may run while seekTo is pending. No network or TV required.
function harness() {
  var elements = {};
  var timers = new Map();
  var now = 0;
  var nextTimer = 0;
  var calls = [];
  var stops = [];
  var stopReasons = [];
  var notices = [];
  var screenSaver = [];
  var prepares = [];
  var seeks = [];
  var state = "NONE";
  var seeking = false;
  function element(id) {
    return elements[id] || (elements[id] = {hidden: true, style: {}, textContent: ""});
  }
  function call(name, args) {
    calls.push({name: name, args: Array.from(args || [])});
    if (seeking) throw new Error("InvalidAccessError: AVPlay operation during seekTo");
  }
  var av = {
    streamInfo: [],
    open: function (url) { call("open", arguments); state = "IDLE"; },
    close: function () { call("close"); state = "NONE"; },
    getState: function () { call("getState"); return state; },
    stop: function () { call("stop"); state = "IDLE"; },
    setListener: function (listener) { call("setListener"); this.listener = listener; },
    setDisplayRect: function () { call("setDisplayRect", arguments); },
    setDisplayMethod: function () { call("setDisplayMethod", arguments); },
    setStreamingProperty: function () { call("setStreamingProperty", arguments); assert.equal(state, "IDLE"); },
    setSilentSubtitle: function () { call("setSilentSubtitle", arguments); },
    getTotalTrackInfo: function () { call("getTotalTrackInfo"); return []; },
    getCurrentStreamInfo: function () { call("getCurrentStreamInfo"); return this.streamInfo; },
    getDuration: function () { call("getDuration"); return 1800000; },
    prepareAsync: function (success, failure) {
      call("prepareAsync");
      prepares.push({success: success, failure: failure, listener: this.listener});
    },
    play: function () {
      call("play");
      assert.ok(state === "READY" || state === "PAUSED", "play must follow prepare or pause");
      state = "PLAYING";
    },
    pause: function () { call("pause"); assert.equal(state, "PLAYING"); state = "PAUSED"; },
    seekTo: function (target, success, failure) {
      call("seekTo", [target]);
      seeking = true;
      seeks.push({target: target, success: success, failure: failure});
    }
  };
  var context = {
    document: {getElementById: element},
    webapis: {
      avplay: av,
      appcommon: {
        AppCommonScreenSaverState: {SCREEN_SAVER_ON: "ON", SCREEN_SAVER_OFF: "OFF"},
        setScreenSaver: function (value) { screenSaver.push(value); }
      }
    },
    Date: {now: function () { return now; }},
    setTimeout: function (fn, delay) { var id = ++nextTimer; timers.set(id, {fn: fn, due: now + delay}); return id; },
    clearTimeout: function (id) { timers.delete(id); }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/player.js"), "utf8"), context);
  var player = new context.SoapPlayer({
    onStop: function (message, reason) { stops.push(message); stopReasons.push(reason); },
    onNotice: function (message) { notices.push(message); }
  });
  function tick(milliseconds) {
    var end = now + milliseconds;
    for (;;) {
      var first = null;
      timers.forEach(function (timer, id) {
        if (timer.due <= end && (!first || timer.due < first.timer.due)) first = {id: id, timer: timer};
      });
      if (!first) break;
      now = first.timer.due;
      timers.delete(first.id);
      first.timer.fn();
    }
    now = end;
  }
  return {
    player: player, av: av, calls: calls, stops: stops, stopReasons: stopReasons, notices: notices,
    screenSaver: screenSaver, prepares: prepares, seeks: seeks, element: element, tick: tick,
    timerCallback: function (id) { return timers.get(id).fn; },
    state: function () { return state; },
    start: function (name, resume) { player.start({stream: "https://example.invalid/" + (name || "episode") + ".mp4", start_from: resume || 0}, name); },
    prepared: function () { state = "READY"; prepares[prepares.length - 1].success(); },
    sought: function (index, failed) { seeking = false; seeks[index][failed ? "failure" : "success"](); },
    count: function (name) { return calls.filter(function (entry) { return entry.name === name; }).length; }
  };
}

test("controls fade after playback starts and stay visible throughout pause", function () {
  var h = harness();
  h.start();
  h.tick(10000);
  assert.equal(h.element("player-controls").style.opacity, "1", "Preparation does not hide controls");
  h.prepared();
  h.tick(4499);
  assert.equal(h.element("player-controls").style.opacity, "1");
  h.tick(1);
  assert.equal(h.element("player-controls").style.opacity, "0");
  assert.equal(h.element("player-controls").hidden, false, "CSS needs the controls rendered during its opacity transition");
  h.player.handleKey(13);
  assert.equal(h.element("player-controls").style.opacity, "1");
  h.tick(10000);
  assert.equal(h.element("player-controls").style.opacity, "1");
  h.player.handleKey(13);
  h.tick(4500);
  assert.equal(h.element("player-controls").style.opacity, "0");
});

test("delayed hide callbacks cannot hide controls after a key, pause or replacement stream", function () {
  var h = harness();
  h.start("first");
  h.prepared();
  var oldHide = h.timerCallback(h.player.controlsTimer);
  h.player.handleKey(38);
  oldHide();
  assert.equal(h.element("player-controls").style.opacity, "1", "A key cancels an already queued hide callback");
  var beforePause = h.timerCallback(h.player.controlsTimer);
  h.player.handleKey(13);
  beforePause();
  assert.equal(h.element("player-controls").style.opacity, "1", "Pause takes precedence over a queued hide");
  h.player.handleKey(13);
  var previousStreamHide = h.timerCallback(h.player.controlsTimer);
  h.start("second");
  h.prepared();
  previousStreamHide();
  assert.equal(h.element("player-controls").style.opacity, "1", "The old episode cannot hide the new episode controls");
  var beforeStop = h.timerCallback(h.player.controlsTimer);
  h.player.handleKey(10009);
  beforeStop();
  assert.equal(h.element("player-controls").style.opacity, "1");
  assert.equal(h.element("player-view").hidden, true);
});

test("quality label uses actual cropped decoder dimensions and resets for the next stream", function () {
  var h = harness();
  h.av.streamInfo = [{type: "VIDEO", extra_info: '{"Width":"3840","Height":"2080"}'}];
  h.player.start({stream: "https://example.invalid/master.m3u8", hlsBitrate: 2500000, quality: 3}, "Movie");
  var previous = h.av.listener;
  previous.oncurrentplaytime(0);
  assert.equal(h.count("getCurrentStreamInfo"), 0, "Decoder metadata must wait until playback is ready");
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА");
  h.prepared();
  previous.oncurrentplaytime(1000);
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА · 4K · 3840×2080");
  previous.oncurrentplaytime(2000);
  assert.equal(h.count("getCurrentStreamInfo"), 1, "Known dimensions do not need native queries on every frame");

  h.av.streamInfo = [{type: "VIDEO", extra_info: {Width: 1920, Height: 804}}];
  h.player.start({stream: "https://example.invalid/episode.mp4", quality: 4}, "Next");
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА");
  h.prepared();
  previous.oncurrentplaytime(3000);
  assert.equal(h.count("getCurrentStreamInfo"), 1, "An old stream must not query the new decoder");
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА");
  h.av.listener.oncurrentplaytime(1000);
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА · Full HD · 1920×804");
});

test("quality reads wait through ordinary and initial resume seeks", function () {
  [0, 120].forEach(function (resume) {
    var h = harness();
    h.av.streamInfo = [{type: "VIDEO", extra_info: '{"Width":3840,"Height":2080}'}];
    h.start("episode", resume);
    h.prepared();
    if (!resume) {
      h.player.handleKey(39);
      h.tick(250);
    }
    var callsBefore = h.calls.length;
    h.av.listener.oncurrentplaytime(1000);
    assert.equal(h.calls.length, callsBefore, "Progress callbacks must make no native calls during seekTo");
    assert.equal(h.count("getCurrentStreamInfo"), 0);
    assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА");
    h.sought(0);
    h.av.listener.oncurrentplaytime(2000);
    assert.equal(h.count("getCurrentStreamInfo"), 1);
    assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА · 4K · 3840×2080");
    assert.equal(h.stops.length, 0);
    assert.equal(h.state(), "PLAYING");
  });
});

test("unavailable or malformed decoder metadata leaves playback running and retries later", function () {
  var h = harness();
  h.start();
  h.prepared();
  h.av.streamInfo = [{type: "AUDIO", extra_info: '{"Width":3840,"Height":2160}'}, {type: "VIDEO", extra_info: '{invalid'}];
  h.av.listener.oncurrentplaytime(1000);
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА");
  h.av.streamInfo = [{type: "VIDEO", extra_info: '{"Width":0,"Height":0}'}];
  h.av.listener.oncurrentplaytime(2000);
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА");
  h.av.streamInfo = [{type: "VIDEO", extra_info: '{"Width":"1280","Height":"536"}'}];
  h.av.listener.oncurrentplaytime(3000);
  assert.equal(h.element("player-label").textContent, "РУССКАЯ ОЗВУЧКА · 720p · 1280×536");
  assert.equal(h.stops.length, 0);
  assert.equal(h.state(), "PLAYING");
});

test("movie AVC bitrate is fixed in IDLE before prepare while MP4 series stay unchanged", function () {
  var h = harness();
  h.player.start({stream: "https://example.invalid/master.m3u8", hlsBitrate: 8235989}, "Movie");
  var adaptive = h.calls.findIndex(function (entry) { return entry.name === "setStreamingProperty"; });
  var prepare = h.calls.findIndex(function (entry) { return entry.name === "prepareAsync"; });
  assert.ok(adaptive > h.calls.findIndex(function (entry) { return entry.name === "open"; }));
  assert.ok(adaptive < prepare);
  assert.deepEqual(h.calls[adaptive].args, ["ADAPTIVE_INFO", "BITRATES=8235889~8236089|STARTBITRATE=8235989"]);
  h.prepared();
  assert.equal(h.state(), "PLAYING");
  h.player.handleKey(10009);
  h.start("series");
  assert.equal(h.count("setStreamingProperty"), 1);
  h.prepared();
  assert.equal(h.state(), "PLAYING");
});

test("failed movie bitrate configuration releases AVPlay and reports a sanitized error", function () {
  var h = harness();
  h.av.setStreamingProperty = function () { throw new Error("private stream configuration"); };
  h.player.start({stream: "https://example.invalid/master.m3u8", hlsBitrate: 8235989}, "Movie");
  assert.equal(h.state(), "NONE");
  assert.equal(h.stops.length, 1);
  assert.equal(h.count("prepareAsync"), 0);
  assert.doesNotMatch(h.stops[0], /private|example/);
});

test("only natural completion signals ended; stale completion, Back and errors do not", function () {
  var h = harness();
  h.start("first");
  h.prepared();
  var finished = h.prepares[0].listener;
  finished.onstreamcompleted();
  assert.equal(h.state(), "NONE");
  assert.deepEqual(h.stopReasons, ["ended"]);
  h.start("second");
  h.prepared();
  finished.onstreamcompleted();
  assert.equal(h.state(), "PLAYING");
  assert.deepEqual(h.stopReasons, ["ended"]);
  h.player.handleKey(10009);
  assert.deepEqual(h.stopReasons, ["ended", undefined]);
  h.start("third");
  h.prepared();
  h.prepares[2].listener.onerror("decoder failure");
  assert.deepEqual(h.stopReasons, ["ended", undefined, undefined]);
});

test("Back during preparation releases video; delayed success/error cannot restart it", function () {
  var h = harness();
  h.start();
  var pending = h.prepares[0];
  assert.equal(h.player.handleKey(10009), true);
  assert.equal(h.state(), "NONE");
  assert.equal(h.element("player-view").hidden, true);
  assert.equal(h.stops.length, 1);
  pending.success();
  pending.failure(new Error("late failure"));
  pending.listener.oncurrentplaytime(20000);
  h.tick(60000);
  assert.equal(h.count("play"), 0);
  assert.equal(h.stops.length, 1);
  assert.equal(h.screenSaver.at(-1), "ON");
});

test("callbacks from replaced episode cannot change or stop the new episode", function () {
  var h = harness();
  h.start("first");
  var previous = h.prepares[0];
  h.start("second");
  h.prepared();
  previous.success();
  previous.failure();
  previous.listener.onerror("old error");
  previous.listener.onstreamcompleted();
  previous.listener.oncurrentplaytime(123000);
  assert.equal(h.state(), "PLAYING");
  assert.equal(h.count("play"), 1);
  assert.equal(h.element("player-title").textContent, "second");
  assert.equal(h.element("player-view").hidden, false);
  assert.equal(h.stops.length, 0);
});

test("prepare errors and timeout return to the catalog exactly once without exposing raw errors", function () {
  ["error", "timeout"].forEach(function (mode) {
    var h = harness();
    h.start();
    var pending = h.prepares[0];
    if (mode === "error") pending.failure(new Error("https://private.invalid/?token=secret"));
    else h.tick(45000);
    pending.listener.onerror("duplicate error with secret");
    h.tick(60000);
    assert.equal(h.state(), "NONE");
    assert.equal(h.stops.length, 1);
    assert.equal(h.element("player-view").hidden, true);
    assert.equal(h.screenSaver.at(-1), "ON");
    assert.doesNotMatch(h.stops[0], /secret|private\.invalid/);
  });
});

test("held arrow keys coalesce and later seeks wait for the active seek callback", function () {
  var h = harness();
  h.start();
  h.prepared();
  h.av.listener.oncurrentplaytime(100000);
  h.player.handleKey(39);
  h.player.handleKey(39);
  h.tick(250);
  assert.deepEqual(h.seeks.map(function (seek) { return seek.target; }), [120000]);
  h.player.handleKey(39);
  h.tick(1000);
  assert.equal(h.seeks.length, 1, "Only one asynchronous AVPlay seek may run");
  h.sought(0);
  h.tick(250);
  assert.deepEqual(h.seeks.map(function (seek) { return seek.target; }), [120000, 130000]);
  h.sought(1);
  assert.equal(h.stops.length, 0);
  assert.equal(h.state(), "PLAYING");
});

test("held seeking accelerates by duration with a five minute step cap and bounded cadence", function () {
  [37, 39].forEach(function (code) {
    var h = harness();
    h.start();
    h.prepared();
    h.player.duration = 72000000;
    h.av.listener.oncurrentplaytime(36000000);
    var direction = code === 37 ? -1 : 1;
    h.player.handleKey(code, {repeat: false});
    assert.equal(h.player.seekTarget, 36000000 + direction * 10000);
    for (var elapsed = 100; elapsed <= 30000; elapsed += 100) {
      var before = h.player.seekTarget;
      h.tick(100);
      // Native repeat flags are not required, including firmware reporting false.
      h.player.handleKey(code, elapsed % 300 ? {repeat: false} : {});
      var step = elapsed >= 15000 ? 300000 : elapsed >= 9000 ? 120000 :
        elapsed >= 5000 ? 60000 : elapsed >= 2000 ? 30000 : 10000;
      assert.equal(h.player.seekTarget - before, elapsed % 500 ? 0 : direction * step,
        "Only one duration-based step per 500 ms, at " + elapsed + " ms");
    }
    assert.equal(h.seeks.length, 0, "Frequent repeats keep one coalesced seek preview");
    var target = h.player.seekTarget;
    h.player.handleKeyUp(code);
    h.tick(249);
    assert.equal(h.seeks.length, 0);
    h.tick(1);
    assert.equal(h.seeks.length, 1);
    assert.equal(h.seeks[0].target, target);
    h.sought(0);
    assert.equal(h.player.seekTarget, null);
    assert.equal(h.state(), "PLAYING");
  });
});

test("slow suppressed repeats do not seek again after the previous seek already completed", function () {
  var h = harness();
  h.start();
  h.prepared();
  h.player.handleKey(39, {});
  h.tick(250);
  h.sought(0);
  h.tick(50);
  h.player.handleKey(39, {});
  assert.equal(h.player.seekTarget, null, "A suppressed repeat does not create a new seek preview");
  h.tick(300);
  assert.equal(h.seeks.length, 1, "No redundant native seek at the current playback position");
  h.player.handleKey(39, {});
  assert.equal(h.player.seekTarget, 20000, "The next allowed repeat still advances normally");
  h.tick(250);
  assert.equal(h.seeks.length, 2);
  assert.equal(h.seeks[1].target, 20000);
  h.sought(1);
});

function holdKey(h, code, milliseconds) {
  h.player.handleKey(code, {});
  for (var elapsed = 100; elapsed <= milliseconds; elapsed += 100) {
    h.tick(100);
    h.player.handleKey(code, {});
  }
}

test("releasing, changing keys and losing focus each restore precise single-step seeking", function () {
  ["release", "direction", "media key", "other key", "blur", "pause"].forEach(function (mode) {
    var h = harness();
    h.start();
    h.prepared();
    h.av.listener.oncurrentplaytime(600000);
    holdKey(h, 39, 2500);
    var before = h.player.seekTarget;
    var code = 39;
    var delta = 10000;
    if (mode === "release") h.player.handleKeyUp(39);
    else if (mode === "direction") { code = 37; delta = -10000; }
    else if (mode === "media key") { code = 417; delta = 30000; }
    else if (mode === "other key") h.player.handleKey(38, {});
    else if (mode === "blur") h.player.resetHold();
    else h.player.setPaused(true);
    h.player.handleKey(code, {});
    assert.equal(h.player.seekTarget - before, delta, mode + " resets hold duration and cadence");
    assert.equal(h.stops.length, 0);
  });
});

test("rapid separate taps do not accelerate and unrelated keyup does not interrupt a hold", function () {
  var h = harness();
  h.start();
  h.prepared();
  for (var elapsed = 0; elapsed <= 3000; elapsed += 100) {
    var before = h.player.seekTarget === null ? h.player.currentTime : h.player.seekTarget;
    h.player.handleKey(39, {});
    h.player.handleKeyUp(39);
    assert.equal(h.player.seekTarget - before, 10000);
    h.tick(100);
  }
  holdKey(h, 39, 2500);
  var target = h.player.seekTarget;
  h.player.handleKeyUp(37);
  for (var repeat = 0; repeat < 5; repeat++) { h.tick(100); h.player.handleKey(39, {}); }
  assert.equal(h.player.seekTarget - target, 30000, "Late keyup of another key cannot reset acceleration");
});

test("a missing keyup expires without runaway seeking and preparation never accumulates hold time", function () {
  var h = harness();
  h.start();
  holdKey(h, 39, 10000);
  assert.equal(h.player.seekHold, null);
  h.prepared();
  h.player.handleKey(39, {});
  assert.equal(h.player.seekTarget, 10000, "Preparation input cannot accelerate the first playable seek");
  holdKey(h, 39, 2500);
  h.tick(1300);
  assert.equal(h.seeks.length, 1);
  h.sought(0);
  var before = h.player.currentTime;
  h.player.handleKey(39, {});
  assert.equal(h.player.seekTarget - before, 10000, "Long gaps reset a missed release");
  h.player.handleKeyUp(39);
  h.tick(250);
  h.sought(1);
  h.tick(30000);
  assert.equal(h.seeks.length, 2, "No timer continues moving the preview after key events stop");
});

test("accelerated seeking stays within playback bounds and native seek failures reset the hold", function () {
  [37, 39].forEach(function (code) {
    var h = harness();
    h.start();
    h.prepared();
    h.av.listener.oncurrentplaytime(900000);
    holdKey(h, code, 16000);
    assert.equal(h.player.seekTarget, code === 37 ? 0 : h.player.duration - 1000);
    h.tick(250);
    h.sought(0, true);
    assert.equal(h.player.seekHold, null);
    assert.equal(h.player.seekTarget, null);
    assert.equal(h.notices.length, 1);
    h.player.handleKey(code, {});
    assert.equal(h.player.seekTarget, 900000 + (code === 37 ? -10000 : 10000));
    h.tick(250);
    h.sought(1);
    assert.equal(h.state(), "PLAYING");
  });
});

test("accelerated repeats queue behind a native seek and cannot affect a replacement stream", function () {
  var h = harness();
  h.start("first");
  h.prepared();
  h.player.handleKey(39, {});
  h.tick(250);
  var callsBefore = h.calls.length;
  holdKey(h, 39, 5500);
  assert.equal(h.seeks.length, 1);
  assert.equal(h.calls.length, callsBefore, "Repeats make no AVPlay call while its callback is pending");
  assert.ok(h.player.seekTarget > 200000);
  h.player.handleKey(13);
  h.player.handleKey(10009);
  h.start("second");
  assert.equal(h.player.seekHold, null);
  assert.equal(h.calls.length, callsBefore, "Pause, stop and replacement all wait for native completion");
  h.sought(0);
  h.prepared();
  h.seeks[0].failure();
  h.seeks[0].success();
  assert.equal(h.state(), "PLAYING");
  h.player.handleKey(39, {});
  assert.equal(h.player.seekTarget, 10000, "A new stream starts with a precise step");
  h.tick(250);
  assert.equal(h.seeks.length, 2);
  assert.equal(h.seeks[1].target, 10000);
  h.sought(1);
  assert.equal(h.count("pause"), 0, "A pause queued by the previous stream is discarded");
});

test("OK during pending seek pauses after completion without closing playback", function () {
  var h = harness();
  h.start();
  h.prepared();
  h.player.handleKey(39);
  h.tick(250);
  h.player.handleKey(13);
  assert.equal(h.stops.length, 0, "Pause must wait for seek completion rather than fail and exit");
  assert.equal(h.count("pause"), 0);
  h.sought(0);
  assert.equal(h.state(), "PAUSED");
  assert.equal(h.element("player-view").hidden, false);
  assert.equal(h.screenSaver.at(-1), "ON");
});

test("Back during pending seek releases the old player before reopening another episode", function () {
  var h = harness();
  h.start("first");
  h.prepared();
  h.player.handleKey(39);
  h.tick(250);
  h.player.handleKey(10009);
  assert.equal(h.element("player-view").hidden, true);
  assert.equal(h.stops.length, 1);
  assert.equal(h.count("close"), 0, "Native close must wait until seekTo completes");
  h.start("second");
  assert.equal(h.count("open"), 1, "New AVPlay open must wait until old seek returns");
  h.sought(0);
  h.tick(250);
  assert.equal(h.count("open"), 2);
  h.prepared();
  assert.equal(h.state(), "PLAYING");
  assert.equal(h.element("player-title").textContent, "second");
  assert.equal(h.stops.length, 1);
});

test("Back during initial resume seek releases the stream without ever starting playback", function () {
  [false, true].forEach(function (seekFails) {
    var h = harness();
    h.start("resume", 120);
    h.prepared();
    assert.equal(h.seeks[0].target, 120000, "Service seconds are converted to AVPlay milliseconds");
    assert.equal(h.count("play"), 0);
    h.player.handleKey(10009);
    assert.equal(h.count("close"), 0);
    h.sought(0, seekFails);
    assert.equal(h.state(), "NONE");
    assert.equal(h.count("play"), 0);
    assert.equal(h.stops.length, 1);
  });
});

test("Back cancels a queued replacement while the previous seek is still pending", function () {
  var h = harness();
  h.start("first");
  h.prepared();
  h.player.handleKey(39);
  h.tick(250);
  h.start("second");
  h.player.handleKey(10009);
  h.sought(0);
  h.tick(60000);
  assert.equal(h.count("open"), 1);
  assert.equal(h.state(), "NONE");
  assert.equal(h.element("player-view").hidden, true);
  assert.equal(h.stops.length, 1);
});

test("failed seeks retain playback, apply requested pause, and allow another seek", function () {
  var h = harness();
  h.start();
  h.prepared();
  h.player.handleKey(39);
  h.tick(250);
  h.player.handleKey(13);
  h.sought(0, true);
  assert.equal(h.state(), "PAUSED");
  assert.equal(h.stops.length, 0);
  assert.equal(h.notices.length, 1);
  h.player.handleKey(37);
  h.tick(250);
  assert.equal(h.seeks.length, 2);
  h.sought(1);
  assert.equal(h.state(), "PAUSED");
});
