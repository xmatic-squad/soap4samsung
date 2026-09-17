"use strict";
var assert = require("node:assert/strict");
var test = require("node:test");
var Catalog = require("../app/catalog.js");

test("ratings accept observed string and numeric fields without guessing aliases", function () {
  assert.equal(Catalog.rating({imdb_rating: " 8.25 "}, "imdb"), 8.25);
  assert.equal(Catalog.rating({kinopoisk_rating: 7.934}, "kinopoisk"), 7.934);
  assert.equal(Catalog.rating({soap_rating: "10"}, "soap"), 10);
  assert.equal(Catalog.rating({rating: 9, imdb: 9}, "imdb"), 0);
  assert.equal(Catalog.rating({soap_rating: 9}, "rating"), 0);
  assert.equal(Catalog.rating({imdb_rating: 9}, "__proto__"), 0);
  assert.equal(Catalog.rating(null, "imdb"), 0);
  [undefined, null, "", " ", 0, "0", -1, "-1", 10.1, "8 points", "8,4", "0x8", "1e0", true, false, [8], {}, Infinity, NaN].forEach(function (value) {
    assert.equal(Catalog.rating({imdb_rating: value}, "imdb"), 0, "Reject malformed or absent rating: " + String(value));
  });
});

test("badges identify each source, round for display, and omit missing values", function () {
  assert.deepEqual(Catalog.ratingBadges({imdb_rating: "8", kinopoisk_rating: 7.934, soap_rating: "9.2"}), [
    {source: "imdb", label: "IMDb", value: 8, text: "8.0"},
    {source: "kinopoisk", label: "КП", value: 7.934, text: "7.9"},
    {source: "soap", label: "Soap", value: 9.2, text: "9.2"}
  ]);
  assert.deepEqual(Catalog.ratingBadges({imdb_rating: 0, kinopoisk_rating: "9.25", soap_rating: null}), [
    {source: "kinopoisk", label: "КП", value: 9.25, text: "9.3"}
  ]);
  assert.deepEqual(Catalog.ratingBadges({}), []);
});

test("each rating sort uses its own unrounded score and puts missing ratings last", function () {
  var shows = [
    {id: 1, title_ru: "Яблоко", imdb_rating: "8.01", kinopoisk_rating: 7, soap_rating: "10"},
    {id: 2, title_ru: "Берег", imdb_rating: 8.04, kinopoisk_rating: "9", soap_rating: 8},
    {id: 3, title_ru: "Апрель", imdb_rating: 0, kinopoisk_rating: null, soap_rating: "bad"}
  ];
  assert.deepEqual(Catalog.sort(shows, "imdb").map(function (item) { return item.id; }), [2, 1, 3]);
  assert.deepEqual(Catalog.sort(shows, "kinopoisk").map(function (item) { return item.id; }), [2, 1, 3]);
  assert.deepEqual(Catalog.sort(shows, "soap").map(function (item) { return item.id; }), [1, 2, 3]);
});

test("sort preserves cached arrays and entries while ordering years, unwatched and titles", function () {
  var shows = Object.freeze([
    Object.freeze({sid: "3", title_ru: "Яблоко", year: "2025", unwatched: "2"}),
    Object.freeze({sid: "2", title_ru: "Берег", year: "2025", unwatched: 10}),
    Object.freeze({sid: "1", title_ru: "Апрель", year: "2024", unwatched: "0"})
  ]);
  var byYear = Catalog.sort(shows, "year");
  assert.notEqual(byYear, shows);
  assert.equal(byYear[0], shows[1]);
  assert.deepEqual(byYear.map(function (item) { return item.sid; }), ["2", "3", "1"]);
  assert.deepEqual(Catalog.sort(shows, "unwatched").map(function (item) { return item.sid; }), ["2", "3", "1"]);
  assert.deepEqual(Catalog.sort(shows, "title").map(function (item) { return item.sid; }), ["1", "2", "3"]);
  assert.deepEqual(Catalog.sort(shows, "unknown"), Catalog.sort(shows, "title"));
  assert.deepEqual(shows.map(function (item) { return item.sid; }), ["3", "2", "1"]);
});

test("year and unwatched sorts ignore invalid numbers instead of ranking them first", function () {
  var shows = [
    {title: "A", year: Infinity, unwatched: -2},
    {title: "B", year: "2025x", unwatched: true},
    {title: "C", year: "2025", unwatched: "2"},
    {title: "D", year: 99999, unwatched: 2.5}
  ];
  assert.deepEqual(Catalog.sort(shows, "year").map(function (item) { return item.title; }), ["C", "A", "B", "D"]);
  assert.deepEqual(Catalog.sort(shows, "unwatched").map(function (item) { return item.title; }), ["C", "A", "B", "D"]);
  assert.deepEqual(Catalog.sort(null, "year"), []);
});

test("title ties use original title and numeric identifiers, then keep input order", function () {
  var shows = [
    {id: "10", title_ru: "Одинаково", title_original: "Alpha"},
    {id: "2", title_ru: "Одинаково", title_original: "Alpha"},
    {id: "1", title_ru: "Одинаково", title_original: "Beta"},
    {title: "Episode 10"},
    {title: "Episode 2"}
  ];
  var sorted = Catalog.sort(shows, "title");
  assert.ok(sorted.indexOf(shows[1]) < sorted.indexOf(shows[0]));
  assert.ok(sorted.indexOf(shows[0]) < sorted.indexOf(shows[2]));
  assert.ok(sorted.indexOf(shows[4]) < sorted.indexOf(shows[3]));
  var identical = Array.from({length: 30}, function (_, index) { return {title: "Equal", ordinal: index}; });
  assert.deepEqual(Catalog.sort(identical, "title"), identical);
});

test("search checks all title aliases with ё, word order and whitespace normalization", function () {
  var show = {title_ru: "Ёлки у моря", title: "Seaside trees", title_original: "Original title", soap_ru: "Другое имя", soap: "Alias name"};
  [" ЕЛКИ  МОРЯ ", "trees seaside", "original", "другое", "alias", "title елки", "", "  "].forEach(function (query) {
    assert.equal(Catalog.matches(show, query), true, query);
  });
  assert.equal(Catalog.matches(show, "моря другое неизвестное"), false);
  assert.equal(Catalog.matches(null, "film"), false);
  assert.equal(Catalog.matches(null, ""), true);
});

test("display title uses the first usable service title", function () {
  assert.equal(Catalog.title({title_ru: "  ", title: "", title_original: "Original"}), "Original");
  assert.equal(Catalog.title({title_ru: "Русское", title: "English"}), "Русское");
  assert.equal(Catalog.title({soap_ru: "Сериал"}), "Сериал");
  assert.equal(Catalog.title(null), "Без названия");
});
