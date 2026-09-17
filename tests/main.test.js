"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var test = require("node:test");
var vm = require("node:vm");

// Run the real application entry point and its modal controllers. This small
// DOM models focus, native Enter clicks, event bubbling and detached elements;
// layout and firmware behavior remain part of the browser/TV smoke checks.
function harness() {
  var ids = {};
  var requests = [];
  var saved = {"soap4samsung.token": "synthetic-session"};
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
    item.appendChild = function (child) { child.parentNode = item; item.children.push(child); return child; };
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
    item.focus = function () { if (item.getBoundingClientRect().width && !item.disabled) document.activeElement = item; };
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
  document.querySelectorAll = function (selector) { return query(root, selector); };
  document.addEventListener = function (name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); };
  function request(kind) {
    return new Promise(function (resolve, reject) { requests.push({kind: kind, resolve: resolve, reject: reject}); });
  }
  function Api(options) { this.token = options.token; }
  Api.prototype.getToken = function () { return this.token; };
  Api.prototype.setToken = function (token) { this.token = token; };
  Api.prototype.getMyShows = function () { return request("my"); };
  Api.prototype.getAllShows = function () { return request("all"); };
  Api.prototype.getMovies = function () { return request("movies"); };
  function Player() { this.active = false; }
  Player.prototype.stop = function () { this.active = false; };
  Player.prototype.handleKey = function () { return false; };
  Player.prototype.handleKeyUp = function () {};
  Player.prototype.resetHold = function () {};
  var context = {
    document: document, SOAP_CONFIG: {version: "test"}, SoapApi: Api, SoapPlayer: Player,
    innerHeight: 1080, scrollBy: function () {}, addEventListener: function () {},
    setTimeout: function () { return 1; }, clearTimeout: function () {}, Date: {now: function () { return 10000; }},
    localStorage: {getItem: function (key) { return saved[key] || null; }, setItem: function (key, value) { saved[key] = value; }, removeItem: function (key) { delete saved[key]; }},
    tizen: {application: {getCurrentApplication: function () { return {exit: function () { exits++; }}; }}}
  };
  context.window = context;
  ["catalog.js", "keyboard.js", "main.js"].forEach(function (file) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/" + file), "utf8"), context, {filename: file});
  });
  return {
    element: document.getElementById, document: document, requests: requests, saved: saved,
    exits: function () { return exits; },
    key: function (code, properties) {
      var target = document.activeElement;
      var event = Object.assign({keyCode: code, prevented: false, preventDefault: function () { this.prevented = true; }}, properties);
      emit("keydown", event);
      if (!event.prevented && code === 13 && target.tagName === "BUTTON") target.click();
      return event;
    },
    release: function (code) { emit("keyup", {keyCode: code}); },
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
    assert.equal(h.element("content").querySelectorAll("button").length, 2);
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
    assert.equal(h.exits(), 1);
  }
});
