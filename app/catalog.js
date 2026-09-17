/* Catalog helpers. No dependencies; compatible with Tizen 5.5. */
(function (root, factory) {
  "use strict";
  var SoapCatalog = factory();
  if (typeof module === "object" && module.exports) module.exports = SoapCatalog;
  else root.SoapCatalog = SoapCatalog;
}(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var TITLE_FIELDS = ["title_ru", "title", "title_original", "soap_ru", "soap"];
  var RATING_SOURCES = [
    {source: "imdb", label: "IMDb", field: "imdb_rating"},
    {source: "kinopoisk", label: "КП", field: "kinopoisk_rating"},
    {source: "soap", label: "Soap", field: "soap_rating"}
  ];

  function number(value) {
    if (typeof value !== "number" &&
        (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return 0;
    var result = Number(value);
    return isFinite(result) && result > 0 ? result : 0;
  }

  function text(value) { return typeof value === "string" ? value.trim() : ""; }

  function title(show) {
    for (var i = 0; show && i < TITLE_FIELDS.length; i += 1) {
      var value = text(show[TITLE_FIELDS[i]]);
      if (value) return value;
    }
    return "Без названия";
  }

  // Only fields observed in the service catalog are accepted. Zero means absent.
  function rating(show, source) {
    if (!show) return 0;
    for (var i = 0; i < RATING_SOURCES.length; i += 1) {
      if (RATING_SOURCES[i].source === source) {
        var value = number(show[RATING_SOURCES[i].field]);
        return value <= 10 ? value : 0;
      }
    }
    return 0;
  }

  // Labels identify the service; text is the rating formatted for a small badge.
  function ratingBadges(show) {
    var badges = [];
    RATING_SOURCES.forEach(function (entry) {
      var value = rating(show, entry.source);
      if (value) badges.push({source: entry.source, label: entry.label, value: value, text: value.toFixed(1)});
    });
    return badges;
  }

  function compareText(a, b) { return a.localeCompare(b, "ru", {sensitivity: "base", numeric: true}); }

  function compareTitles(a, b) {
    var difference = compareText(title(a), title(b));
    for (var i = 0; !difference && i < TITLE_FIELDS.length; i += 1) {
      difference = compareText(text(a && a[TITLE_FIELDS[i]]), text(b && b[TITLE_FIELDS[i]]));
    }
    if (difference) return difference;
    var idA = a && (a.sid || a.id);
    var idB = b && (b.sid || b.id);
    return compareText(idA === undefined || idA === null ? "" : String(idA), idB === undefined || idB === null ? "" : String(idB));
  }

  function sortValue(show, mode) {
    if (!show) return 0;
    if (mode === "year" || mode === "unwatched") {
      var value = number(show[mode]);
      return Math.floor(value) === value && (mode !== "year" || value <= 9999) ? value : 0;
    }
    return rating(show, mode);
  }

  // Sorting changes neither the cached array nor its objects. Equal items retain
  // their input order even on Chromium 69, whose Array.sort is not always stable.
  function sort(shows, mode) {
    if (!Array.isArray(shows)) return [];
    return shows.map(function (show, index) { return {show: show, index: index}; }).sort(function (a, b) {
      return sortValue(b.show, mode) - sortValue(a.show, mode) ||
        compareTitles(a.show, b.show) || a.index - b.index;
    }).map(function (entry) { return entry.show; });
  }

  function normalize(value) { return text(value).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " "); }

  function matches(show, query) {
    var normalized = normalize(query);
    if (!normalized) return true;
    var haystack = normalize(TITLE_FIELDS.map(function (field) { return text(show && show[field]); }).join(" "));
    return normalized.split(" ").every(function (word) { return haystack.indexOf(word) !== -1; });
  }

  return {title: title, rating: rating, ratingBadges: ratingBadges, sort: sort, matches: matches};
}));
