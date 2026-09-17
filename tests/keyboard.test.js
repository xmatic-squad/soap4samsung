"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var test = require("node:test");
var vm = require("node:vm");

function harness() {
  var elements = {};
  var applied = [];
  var document = { activeElement: null };
  function element(id) {
    var listeners = {};
    var attributes = {};
    var classes = {};
    var result = {
      id: id, hidden: true, textContent: "", children: [], scrollWidth: 500,
      classList: {
        toggle: function (name, value) { classes[name] = value; },
        contains: function (name) { return !!classes[name]; }
      },
      appendChild: function (child) { this.children.push(child); },
      removeChild: function (child) { this.children.splice(this.children.indexOf(child), 1); },
      setAttribute: function (name, value) { attributes[name] = value; },
      getAttribute: function (name) { return attributes[name]; },
      removeAttribute: function (name) { delete attributes[name]; },
      addEventListener: function (name, fn) { listeners[name] = fn; },
      focus: function () { document.activeElement = this; },
      click: function () { if (listeners.click) listeners.click(); }
    };
    Object.defineProperty(result, "firstChild", {get: function () { return this.children[0]; }});
    return result;
  }
  document.getElementById = function (id) { return elements[id] || (elements[id] = element(id)); };
  document.createElement = function () { return element(""); };
  var context = {document: document};
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/keyboard.js"), "utf8"), context);
  var keyboard = new context.SoapKeyboard({onApply: function (query) { applied.push(query); }});
  var opener = document.getElementById("search");
  opener.focus();
  function key(code, properties) {
    var event = Object.assign({keyCode: code, prevented: false, preventDefault: function () { this.prevented = true; }}, properties);
    event.handled = keyboard.handleKey(event);
    return event;
  }
  function release() { keyboard.handleKeyUp({keyCode: 13}); }
  function button(label) {
    var found;
    keyboard.rows.forEach(function (row) { row.forEach(function (item) { if (item.textContent === label) found = item; }); });
    assert.ok(found, "Keyboard has button " + label);
    return found;
  }
  return {
    keyboard: keyboard, document: document, applied: applied, opener: opener,
    element: document.getElementById, key: key, release: release, button: button,
    open: function (query, openingOK) { keyboard.open(query || "", opener, openingOK); }
  };
}

test("opening OK and its repeats cannot enter the initial letter", function () {
  var h = harness();
  assert.equal(h.keyboard.active, false);
  assert.equal(h.key(40).handled, false, "Closed keyboard does not intercept browsing");
  h.open("", true);
  assert.equal(h.element("search-keyboard").hidden, false);
  assert.equal(h.element("app-shell").getAttribute("aria-hidden"), "true");
  assert.equal(h.document.activeElement.textContent, "й");
  assert.equal(h.key(13).prevented, true);
  h.key(13, {repeat: true});
  h.document.activeElement.click();
  assert.equal(h.keyboard.draft, "");
  h.release();
  h.key(13);
  assert.equal(h.keyboard.draft, "й");
  h.key(13);
  h.document.activeElement.click();
  assert.equal(h.keyboard.draft, "й", "Holding OK types once, even without event.repeat");
  h.release();
  h.key(13);
  assert.equal(h.keyboard.draft, "йй");
});

test("remote arrows stay inside the grid and align the wider action buttons", function () {
  var h = harness();
  h.open();
  h.key(38);
  assert.equal(h.document.activeElement.textContent, "1");
  h.key(39);
  h.key(40);
  assert.equal(h.document.activeElement.textContent, "ц");
  h.key(37);
  h.key(37);
  assert.equal(h.document.activeElement.textContent, "й");
  h.button("?").focus();
  h.key(40);
  assert.equal(h.document.activeElement.textContent, "Отмена");
  h.key(40);
  h.key(39);
  assert.equal(h.document.activeElement.textContent, "Отмена");
  h.key(38);
  assert.equal(h.document.activeElement.textContent, "?");
  h.opener.focus();
  h.key(40);
  assert.equal(h.document.activeElement.textContent, "й", "Arrow recovers a focus that escaped programmatically");
});

test("Russian, English, numbers, punctuation and editing actions preserve the draft", function () {
  var h = harness();
  h.open();
  var russian = h.keyboard.rows.slice(1).map(function (row) { return row.map(function (button) { return button.textContent; }).join(""); }).join("");
  "абвгдеёжзийклмнопрстуфхцчшщъыьэюя".split("").forEach(function (letter) { assert.ok(russian.indexOf(letter) !== -1, letter); });
  "кино".split("").forEach(function (letter) { h.button(letter).click(); });
  h.button("Пробел").click();
  h.button("РУ → EN").click();
  assert.equal(h.document.activeElement.textContent, "EN → РУ");
  "tv42?".split("").forEach(function (letter) { h.button(letter).click(); });
  assert.equal(h.keyboard.draft, "кино tv42?");
  h.button("⌫").click();
  assert.equal(h.element("keyboard-query").textContent, "кино tv42");
  h.button("Очистить").click();
  assert.equal(h.keyboard.draft, "");
  assert.equal(h.element("keyboard-query").classList.contains("muted"), true);
  assert.equal(h.applied.length, 0, "Typing does not apply the search prematurely");
});

test("switching layouts with OK does not type through a held key", function () {
  var h = harness();
  h.open("пример");
  h.button("РУ → EN").focus();
  h.key(13);
  assert.equal(h.keyboard.language, "en");
  h.key(13);
  h.document.activeElement.click();
  assert.equal(h.keyboard.language, "en");
  assert.equal(h.keyboard.draft, "пример");
  h.release();
  h.key(13);
  assert.equal(h.keyboard.language, "ru");
});

test("remote keys can type 1+1 in either layout and English includes title punctuation", function () {
  var h = harness();
  h.open();
  ["ru", "en"].forEach(function (language) {
    if (language === "en") h.button("РУ → EN").click();
    h.button("Очистить").click();
    ["1", "+", "1"].forEach(function (label) { h.button(label).click(); });
    assert.equal(h.keyboard.draft, "1+1");
  });
  ["(", ")", "'"].forEach(function (label) { h.button(label).click(); });
  assert.equal(h.keyboard.draft, "1+1()'");
  h.button("Найти").click();
  assert.deepEqual(h.applied, ["1+1()'"]);
});

test("losing window focus releases an OK latch whose keyup went to another app", function () {
  var h = harness();
  h.open("", true);
  h.key(13);
  assert.equal(h.keyboard.draft, "");
  h.keyboard.handleBlur();
  h.key(13, {repeat: true});
  assert.equal(h.keyboard.draft, "", "A resumed held key still cannot type");
  h.key(13);
  assert.equal(h.keyboard.draft, "й", "A fresh OK works after lost keyup");
  h.key(13);
  assert.equal(h.keyboard.draft, "й", "The normal latch resumes immediately");
});

test("Find applies once and restores the search focus; Back cancels edits", function () {
  var h = harness();
  h.open("старый");
  h.button("Очистить").click();
  h.button("я").click();
  h.button("Найти").focus();
  h.key(13);
  assert.deepEqual(h.applied, ["я"]);
  assert.equal(h.keyboard.active, false);
  assert.equal(h.element("search-keyboard").hidden, true);
  assert.equal(h.element("app-shell").getAttribute("aria-hidden"), undefined);
  assert.equal(h.document.activeElement, h.opener);
  assert.equal(h.keyboard.enterDown, true, "Main can suppress reopening before OK release");
  h.release();
  h.open("я");
  h.button("ф").click();
  assert.equal(h.key(10009).handled, true);
  assert.equal(h.keyboard.active, false);
  assert.equal(h.document.activeElement, h.opener);
  assert.deepEqual(h.applied, ["я"]);
  h.open("я");
  assert.equal(h.keyboard.draft, "я");
  h.key(27);
  assert.equal(h.keyboard.active, false);
});

test("Cancel button and lifecycle close discard edits without committing", function () {
  var h = harness();
  h.open("query");
  h.button("Отмена").click();
  assert.equal(h.document.activeElement, h.opener);
  assert.equal(h.keyboard.active, false);
  h.open("query");
  var login = h.element("login-name");
  login.focus();
  h.keyboard.close(false, false);
  assert.equal(h.document.activeElement, login, "Authentication can close the modal without restoring stale search focus");
  assert.deepEqual(h.applied, []);
});

test("physical typing, Space and Backspace edit text without native button activation", function () {
  var h = harness();
  h.open();
  "Игра 2 <&>".split("").forEach(function (letter) {
    var event = h.key(letter === " " ? 32 : 0, {key: letter});
    assert.equal(event.prevented, true);
  });
  assert.equal(h.keyboard.draft, "Игра 2 <&>");
  assert.equal(h.element("keyboard-query").textContent, "Игра 2 <&>");
  h.key(8);
  assert.equal(h.keyboard.draft, "Игра 2 <&");
  h.key(65, {key: "a", ctrlKey: true});
  h.key(65, {key: "a", altKey: true});
  assert.equal(h.keyboard.draft, "Игра 2 <&");
  assert.deepEqual(h.applied, []);
  for (var i = 0; i < 110; i++) h.key(65, {key: "a"});
  assert.equal(h.keyboard.draft.length, 100, "Repeated keys cannot grow the draft without a bound");
});

test("Tab and Shift+Tab cycle within the modal", function () {
  var h = harness();
  h.open();
  h.button("1").focus();
  assert.equal(h.key(9, {shiftKey: true}).prevented, true);
  assert.equal(h.document.activeElement.textContent, "Отмена");
  h.key(9);
  assert.equal(h.document.activeElement.textContent, "1");
  h.key(9);
  assert.equal(h.document.activeElement.textContent, "2");
});
