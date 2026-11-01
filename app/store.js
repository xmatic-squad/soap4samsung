/* Local watch state. No DOM, service credentials or playback URLs. */
(function (root, factory) {
  "use strict";
  var SoapStore = factory();
  if (typeof module === "object" && module.exports) module.exports = SoapStore;
  else root.SoapStore = SoapStore;
}(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var PREFIX = "soap4samsung.local.";
  var BUDGET = 1024 * 1024;
  var TEXT_FIELDS = ["title", "title_ru", "title_original", "soap", "soap_ru"];
  var NUMBER_FIELDS = ["year", "imdb_rating", "kinopoisk_rating", "soap_rating", "unwatched", "runtime"];

  function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
  function numeric(value) {
    if (typeof value !== "number" &&
        (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return false;
    var result = Number(value);
    return isFinite(result) && result >= 0;
  }
  function number(value) { return numeric(value) ? Number(value) : 0; }
  function id(value) {
    if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value).trim())) return null;
    var result = Number(value);
    return isFinite(result) && result <= 9007199254740991 ? String(result) : null;
  }
  function kindValid(kind) { return kind === "show" || kind === "movie"; }
  function ownKey(key) { return typeof key === "string" && /^soap4samsung\.local\.(meta|favorites|show\.\d+|movie\.\d+)$/.test(key); }
  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (!object(value)) return value;
    var result = {};
    Object.keys(value).forEach(function (key) {
      if (key !== "__proto__") result[key] = copy(value[key]);
    });
    return result;
  }
  function mediaInfo(media) {
    if (!object(media)) return null;
    var itemId = id(media.kind === "episode" ? media.sid : media.id);
    if (itemId === null) return null;
    if (media.kind === "movie") return {key: PREFIX + "movie." + itemId, id: itemId, kind: "movie"};
    var season = id(media.season);
    var episode = id(media.episode);
    if (media.kind !== "episode" || season === null || episode === null) return null;
    return {key: PREFIX + "show." + itemId, id: itemId, kind: "show", episode: season + ":" + episode};
  }
  function empty(key) {
    var doc = {schemaVersion: 1};
    if (key === PREFIX + "favorites") {
      doc.show = Object.create(null);
      doc.movie = Object.create(null);
    } else if (key.indexOf(PREFIX + "show.") === 0) doc.episodes = Object.create(null);
    return doc;
  }
  function record(value) {
    if (!object(value) || ["unwatched", "progress", "watched"].indexOf(value.status) === -1) return null;
    var result = {
      status: value.status,
      positionMs: value.status === "progress" ? number(value.positionMs) : 0,
      durationMs: number(value.durationMs),
      updatedAt: number(value.updatedAt)
    };
    if (value.status === "progress" && value.unset === true) result.unset = true;
    return result;
  }
  // A position alone says nothing about the watched state; only explicit marks
  // and completed playback override the service.
  function following(saved) { return saved.status === "progress" && !saved.unset; }
  function serverWatched(value) { return value === true || value === 1 || value === "1"; }
  function quotaError(error) {
    return error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014);
  }
  function episodeKey(value) {
    if (!object(value)) return null;
    var season = id(value.season);
    var episode = id(value.episode);
    return season === null || episode === null ? null : season + ":" + episode;
  }
  function validEpisodeKey(key) { return /^\d+:\d+$/.test(key) && episodeKey({season: key.split(":")[0], episode: key.split(":")[1]}) === key; }

  function card(kind, item) {
    if (!kindValid(kind) || !object(item)) return null;
    var field = kind === "show" ? "sid" : "id";
    var itemId = id(item[field]);
    if (itemId === null) return null;
    var result = {};
    result[field] = itemId;
    TEXT_FIELDS.forEach(function (name) {
      if (typeof item[name] === "string" && item[name].trim()) result[name] = item[name].trim();
    });
    NUMBER_FIELDS.forEach(function (name) {
      var value = number(item[name]);
      var rating = name.indexOf("_rating") !== -1;
      if (rating ? value > 0 && value <= 10 : value > 0 || (name === "unwatched" && (item[name] === 0 || item[name] === "0"))) result[name] = value;
    });
    if (object(item.covers)) {
      var coverName = item.covers.small ? "small" : "big";
      var url = item.covers[coverName];
      if (typeof url === "string" && /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(url)) {
        result.covers = {};
        result.covers[coverName] = url;
      }
    }
    return result;
  }

  function sanitize(key, value) {
    var doc = empty(key);
    if (!object(value) || value.schemaVersion !== 1) return doc;
    if (key === PREFIX + "meta") {
      if (value.favoritesImported === true) doc.favoritesImported = true;
    } else if (key === PREFIX + "favorites") {
      ["show", "movie"].forEach(function (kind) {
        if (!object(value[kind])) return;
        Object.keys(value[kind]).forEach(function (itemId) {
          var entry = value[kind][itemId];
          if (id(itemId) !== itemId || !object(entry)) return;
          var snapshot = card(kind, entry.card);
          if (!snapshot || snapshot[kind === "show" ? "sid" : "id"] !== itemId) return;
          doc[kind][itemId] = {card: snapshot, updatedAt: number(entry.updatedAt)};
        });
      });
    } else {
      var kind = key.indexOf(PREFIX + "show.") === 0 ? "show" : "movie";
      var snapshot = card(kind, value.card);
      if (snapshot && snapshot[kind === "show" ? "sid" : "id"] === key.slice((PREFIX + kind + ".").length)) doc.card = snapshot;
      if (kind === "show") {
        if (object(value.episodes)) Object.keys(value.episodes).forEach(function (entry) {
          var saved = record(value.episodes[entry]);
          if (validEpisodeKey(entry) && saved) doc.episodes[entry] = saved;
        });
        if (object(value.serverWatched)) {
          doc.serverWatched = Object.create(null);
          Object.keys(value.serverWatched).forEach(function (entry) {
            if (validEpisodeKey(entry)) doc.serverWatched[entry] = serverWatched(value.serverWatched[entry]);
          });
          doc.serverUnwatched = number(value.serverUnwatched);
          adjust(doc);
        }
      } else {
        var saved = record(value.record);
        if (saved) doc.record = saved;
      }
    }
    return doc;
  }
  function adjust(doc) {
    if (!doc.serverWatched) return;
    var correction = 0;
    Object.keys(doc.serverWatched).forEach(function (key) {
      var local = doc.episodes[key];
      if (local && !following(local)) correction += (local.status === "watched" ? 1 : 0) - (doc.serverWatched[key] ? 1 : 0);
    });
    doc.adjustment = correction;
  }
  function docRecord(doc, info) { return info.kind === "show" ? doc.episodes[info.episode] : doc.record; }
  function putRecord(doc, info, value) {
    if (info.kind === "show") { doc.episodes[info.episode] = value; adjust(doc); }
    else doc.record = value;
  }
  function attachCard(doc, info, item) {
    var snapshot = card(info.kind, item);
    if (snapshot && snapshot[info.kind === "show" ? "sid" : "id"] === info.id) doc.card = snapshot;
  }

  function SoapStore(options) {
    options = options || {};
    this.storage = options.storage;
    if (!this.storage) {
      try { this.storage = typeof localStorage !== "undefined" ? localStorage : null; } catch (ignore) {}
    }
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.onWriteError = typeof options.onWriteError === "function" ? options.onWriteError : function () {};
    this._cache = Object.create(null);
    this._lastStamp = -1;
  }
  SoapStore.card = card;
  SoapStore.prototype._error = function (error) {
    // UI error handlers must not turn a storage failure into a player exception.
    try { this.onWriteError(error); } catch (ignore) {}
  };
  SoapStore.prototype._read = function (key) {
    if (this._cache[key]) return this._cache[key];
    var value = null;
    try { value = JSON.parse(this.storage.getItem(key)); } catch (ignore) {}
    this._cache[key] = sanitize(key, value);
    return this._cache[key];
  };
  SoapStore.prototype._keys = function () {
    var keys = [];
    for (var i = 0; i < this.storage.length; i += 1) {
      var key = this.storage.key(i);
      if (ownKey(key)) keys.push(key);
    }
    return keys;
  };
  SoapStore.prototype._stamp = function () {
    // Keep calls in the same millisecond ordered, even on Chromium's unstable sort.
    this._lastStamp = Math.max(number(this.now()), this._lastStamp + 1);
    return this._lastStamp;
  };

  // Approximate UTF-16 storage cost, including keys. Eviction is durable and may
  // precede a failed write. Only successful setItem calls update the read cache;
  // a failed mutation returns the actual stored record, never an optimistic one.
  SoapStore.prototype._write = function (key, doc) {
    var self = this;
    try {
      var keys = this._keys();
      if (keys.indexOf(key) === -1) keys.push(key);
      var sizes = Object.create(null);
      var total = 0;
      var victims = null;
      keys.forEach(function (entry) {
        var raw = self.storage.getItem(entry);
        sizes[entry] = raw === null ? 0 : 2 * (entry.length + raw.length);
        total += sizes[entry];
      });
      var failure = new Error("Local storage budget exceeded");
      while (true) {
        var raw = JSON.stringify(doc);
        var nextSize = 2 * (key.length + raw.length);
        if (total - sizes[key] + nextSize <= BUDGET) {
          try {
            this.storage.setItem(key, raw);
            this._cache[key] = doc;
            return true;
          } catch (error) {
            if (!quotaError(error)) throw error;
            failure = error;
          }
        }
        // Routine progress writes do not parse unrelated media documents. Load
        // eviction candidates only after the budget or actual quota is reached.
        if (!victims) {
          victims = [];
          keys.forEach(function (entry) {
            var candidate = entry === key ? doc : self._read(entry);
            function victim(type, name, stamp) { victims.push({key: entry, type: type, name: name, stamp: stamp}); }
            var newest = 0;
            if (candidate.episodes) Object.keys(candidate.episodes).forEach(function (name) {
              var saved = candidate.episodes[name];
              newest = Math.max(newest, saved.updatedAt);
              if (saved.status === "progress") victim("episode", name, saved.updatedAt);
            });
            if (candidate.record) {
              newest = candidate.record.updatedAt;
              if (candidate.record.status === "progress") victim("record", null, newest);
            }
            if (candidate.card) victim("card", null, newest);
            if (entry === PREFIX + "favorites") ["show", "movie"].forEach(function (kind) {
              Object.keys(candidate[kind]).forEach(function (itemId) {
                if (Object.keys(candidate[kind][itemId].card).length > 1) victim(kind, itemId, candidate[kind][itemId].updatedAt);
              });
            });
          });
          victims.sort(function (a, b) {
            return a.stamp - b.stamp || (a.type === "card" ? 0 : 1) - (b.type === "card" ? 0 : 1);
          });
        }
        var victim = victims.shift();
        if (!victim) throw failure;
        var reduced = victim.key === key ? doc : copy(this._read(victim.key));
        if (victim.type === "card") delete reduced.card;
        else if (victim.type === "show" || victim.type === "movie") {
          var minimal = {};
          minimal[victim.type === "show" ? "sid" : "id"] = victim.name;
          reduced[victim.type][victim.name].card = minimal;
        } else {
          var saved = victim.type === "episode" ? reduced.episodes[victim.name] : reduced.record;
          if (saved.unset) {
            saved.status = "unwatched";
            saved.positionMs = 0;
            delete saved.unset;
          } else if (victim.type === "episode") delete reduced.episodes[victim.name];
          else delete reduced.record;
          if (victim.type === "episode") adjust(reduced);
        }
        if (victim.key !== key) {
          var reducedRaw = JSON.stringify(reduced);
          this.storage.setItem(victim.key, reducedRaw);
          this._cache[victim.key] = reduced;
          total -= sizes[victim.key];
          sizes[victim.key] = 2 * (victim.key.length + reducedRaw.length);
          total += sizes[victim.key];
        }
      }
    } catch (error) {
      delete this._cache[key];
      this._error(error);
      return false;
    }
  };

  SoapStore.prototype.get = function (media) {
    var info = mediaInfo(media);
    if (!info) return null;
    return copy(docRecord(this._read(info.key), info) || null);
  };
  SoapStore.prototype.saveProgress = function (media, snapshot, item) {
    var info = mediaInfo(media);
    if (!info) return null;
    var doc = copy(this._read(info.key));
    var previous = docRecord(doc, info);
    if (previous && previous.status === "watched") return copy(previous);
    snapshot = object(snapshot) ? snapshot : {};
    var position = number(snapshot.positionMs);
    var duration = number(snapshot.durationMs);
    var watched = snapshot.ended === true || (duration > 0 && position / duration >= 0.9 && number(snapshot.playedSinceSeekMs) >= 30000);
    // A failed resume seek reports 0 before the first tick; keep the known position.
    if (!watched && position === 0 && previous) return copy(previous);
    var saved = {status: watched ? "watched" : "progress", positionMs: watched ? 0 : position, durationMs: duration, updatedAt: this._stamp()};
    if (!watched && previous && (previous.status === "unwatched" || previous.unset)) saved.unset = true;
    putRecord(doc, info, saved);
    attachCard(doc, info, item);
    this._write(info.key, doc);
    return this.get(media);
  };
  SoapStore.prototype.setWatched = function (media, watched, item) {
    var info = mediaInfo(media);
    if (!info) return null;
    var doc = copy(this._read(info.key));
    var previous = docRecord(doc, info);
    var status = watched === true ? "watched" : "unwatched";
    if (previous && previous.status === status && previous.positionMs === 0) return copy(previous);
    putRecord(doc, info, {status: status, positionMs: 0, durationMs: previous ? previous.durationMs : 0, updatedAt: this._stamp()});
    attachCard(doc, info, item);
    this._write(info.key, doc);
    return this.get(media);
  };
  SoapStore.prototype.setEpisodesWatched = function (sid, episodes, watched, item) {
    var itemId = id(sid);
    if (itemId === null || !Array.isArray(episodes)) return;
    var key = PREFIX + "show." + itemId;
    var doc = copy(this._read(key));
    var stamp = this._stamp();
    var changed = false;
    episodes.forEach(function (episode) {
      var name = episodeKey(episode);
      if (!name) return;
      var previous = doc.episodes[name];
      var status = watched === true ? "watched" : "unwatched";
      if (previous && previous.status === status && previous.positionMs === 0) return;
      doc.episodes[name] = {status: status, positionMs: 0, durationMs: previous ? previous.durationMs : 0, updatedAt: stamp};
      changed = true;
    });
    if (!changed) return;
    adjust(doc);
    attachCard(doc, {kind: "show", id: itemId}, item);
    this._write(key, doc);
  };
  SoapStore.prototype.effectiveWatched = function (media, watched) {
    var saved = this.get(media);
    return saved && !following(saved) ? saved.status === "watched" : serverWatched(watched);
  };
  SoapStore.prototype.resumeMs = function (media, serverStartFromSec) {
    var saved = this.get(media);
    return saved ? saved.status !== "watched" && saved.positionMs > 60000 ? saved.positionMs - 5000 : 0 : number(serverStartFromSec) * 1000;
  };
  SoapStore.prototype.syncShowEpisodes = function (sid, episodes) {
    var itemId = id(sid);
    if (itemId === null || !Array.isArray(episodes)) return;
    var key = PREFIX + "show." + itemId;
    var doc = copy(this._read(key));
    doc.serverWatched = Object.create(null);
    episodes.forEach(function (episode) {
      var name = episodeKey(episode);
      if (name) doc.serverWatched[name] = serverWatched(episode.watched);
    });
    doc.serverUnwatched = Object.keys(doc.serverWatched).filter(function (name) { return !doc.serverWatched[name]; }).length;
    adjust(doc);
    this._write(key, doc);
  };
  SoapStore.prototype.adjustedUnwatched = function (show) {
    if (!object(show) || id(show.sid) === null || !numeric(show.unwatched)) return 0;
    var count = number(show.unwatched);
    return Math.max(0, count - (this._read(PREFIX + "show." + id(show.sid)).adjustment || 0));
  };
  SoapStore.prototype.isFavorite = function (kind, itemId) {
    return kindValid(kind) && id(itemId) !== null && !!this._read(PREFIX + "favorites")[kind][id(itemId)];
  };
  SoapStore.prototype.toggleFavorite = function (kind, item) {
    var snapshot = card(kind, item);
    if (!snapshot) return false;
    var key = PREFIX + "favorites";
    var doc = copy(this._read(key));
    var itemId = snapshot[kind === "show" ? "sid" : "id"];
    if (doc[kind][itemId]) delete doc[kind][itemId];
    else doc[kind][itemId] = {card: snapshot, updatedAt: this._stamp()};
    this._write(key, doc);
    return this.isFavorite(kind, itemId);
  };
  SoapStore.prototype.favorites = function (kind) {
    if (!kindValid(kind)) return [];
    var entries = this._read(PREFIX + "favorites")[kind];
    return Object.keys(entries).sort(function (a, b) { return entries[b].updatedAt - entries[a].updatedAt; }).map(function (key) { return copy(entries[key].card); });
  };
  SoapStore.prototype.refreshCards = function (kind, items) {
    if (!kindValid(kind) || !Array.isArray(items)) return;
    var key = PREFIX + "favorites";
    var doc = copy(this._read(key));
    var changed = false;
    items.forEach(function (item) {
      var snapshot = card(kind, item);
      if (!snapshot) return;
      var itemId = snapshot[kind === "show" ? "sid" : "id"];
      if (doc[kind][itemId]) { doc[kind][itemId].card = snapshot; changed = true; }
    });
    if (changed) this._write(key, doc);
  };
  SoapStore.prototype.importFavoritesOnce = function (shows) {
    var metaKey = PREFIX + "meta";
    var meta = copy(this._read(metaKey));
    if (meta.favoritesImported || !Array.isArray(shows)) return false;
    var key = PREFIX + "favorites";
    var doc = copy(this._read(key));
    var stamp = this._stamp();
    shows.forEach(function (show) {
      var snapshot = card("show", show);
      if (snapshot && !doc.show[snapshot.sid]) doc.show[snapshot.sid] = {card: snapshot, updatedAt: stamp};
    });
    if (!this._write(key, doc)) return false;
    meta.favoritesImported = true;
    return this._write(metaKey, meta);
  };
  SoapStore.prototype._continued = function (key) {
    var doc = this._read(key);
    if (!doc.card) return null;
    if (doc.episodes) {
      // The newest activity wins: a finished episode means "go on to the next one".
      var names = Object.keys(doc.episodes).filter(function (name) {
        var saved = doc.episodes[name];
        return (saved.status === "progress" && saved.positionMs > 0) || saved.status === "watched";
      });
      names.sort(function (a, b) { return doc.episodes[b].updatedAt - doc.episodes[a].updatedAt; });
      if (!names.length) return null;
      var parts = names[0].split(":");
      return {card: copy(doc.card), media: {kind: "episode", sid: doc.card.sid, season: Number(parts[0]), episode: Number(parts[1])}, record: copy(doc.episodes[names[0]])};
    }
    return doc.record && doc.record.status === "progress" && doc.record.positionMs > 0 ? {card: copy(doc.card), media: {kind: "movie", id: doc.card.id}, record: copy(doc.record)} : null;
  };
  SoapStore.prototype.continueList = function (kind, limit) {
    if (!kindValid(kind)) return [];
    var self = this;
    var result = [];
    try {
      this._keys().forEach(function (key) {
        if (key.indexOf(PREFIX + kind + ".") !== 0) return;
        var entry = self._continued(key);
        if (entry) result.push(entry);
      });
    } catch (ignore) {}
    result.sort(function (a, b) { return b.record.updatedAt - a.record.updatedAt; });
    return result.slice(0, limit === undefined ? result.length : Math.floor(number(limit)));
  };
  SoapStore.prototype.nextEpisodeLabel = function (sid) {
    var itemId = id(sid);
    if (itemId === null) return null;
    var doc = this._read(PREFIX + "show." + itemId);
    var names = Object.keys(doc.episodes).filter(function (name) { return doc.episodes[name].status === "progress"; });
    names.sort(function (a, b) { return doc.episodes[b].updatedAt - doc.episodes[a].updatedAt; });
    if (!names.length) return null;
    var saved = doc.episodes[names[0]];
    var parts = names[0].split(":");
    return {season: Number(parts[0]), episode: Number(parts[1]), positionMs: saved.positionMs, durationMs: saved.durationMs};
  };
  SoapStore.prototype.reset = function () {
    try {
      var self = this;
      this._keys().forEach(function (key) { self.storage.removeItem(key); delete self._cache[key]; });
      this._cache = Object.create(null);
    } catch (error) { this._cache = Object.create(null); this._error(error); }
  };

  return SoapStore;
}));
