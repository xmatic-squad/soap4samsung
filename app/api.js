/* Soap4me API client. No dependencies; compatible with Tizen 5.5. */
(function (root, factory) {
  "use strict";
  var SoapApi = factory(root);
  if (typeof module === "object" && module.exports) module.exports = SoapApi;
  else root.SoapApi = SoapApi;
}(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  function apiError(code, message, status) {
    var error = new Error(message);
    error.name = "SoapApiError";
    error.code = code;
    error.status = status || 0;
    return error;
  }

  function utf8(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + next - 0xdc00;
          i += 1;
        } else code = 0xfffd;
      } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return bytes;
  }

  // Independent implementation of the MD5 algorithm used by the playback API.
  // MD5 is required by the service protocol, not used to protect credentials.
  function md5(text) {
    var bytes = utf8(String(text));
    var byteLength = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var lowLength = (byteLength * 8) >>> 0;
    var highLength = Math.floor(byteLength / 0x20000000);
    for (var n = 0; n < 4; n += 1) bytes.push((lowLength >>> (n * 8)) & 255);
    for (n = 0; n < 4; n += 1) bytes.push((highLength >>> (n * 8)) & 255);

    var state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    var rotations = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (var offset = 0; offset < bytes.length; offset += 64) {
      var words = [];
      for (n = 0; n < 16; n += 1) {
        var pos = offset + n * 4;
        words.push(bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24));
      }
      var a = state[0], b = state[1], c = state[2], d = state[3];
      for (n = 0; n < 64; n += 1) {
        var f, index;
        if (n < 16) { f = (b & c) | (~b & d); index = n; }
        else if (n < 32) { f = (d & b) | (~d & c); index = (5 * n + 1) % 16; }
        else if (n < 48) { f = b ^ c ^ d; index = (3 * n + 5) % 16; }
        else { f = c ^ (b | ~d); index = (7 * n) % 16; }
        var sum = (a + f + Math.floor(Math.abs(Math.sin(n + 1)) * 0x100000000) + words[index]) | 0;
        var shift = rotations[Math.floor(n / 16) * 4 + n % 4];
        a = d;
        d = c;
        c = b;
        b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      }
      state[0] = (state[0] + a) | 0;
      state[1] = (state[1] + b) | 0;
      state[2] = (state[2] + c) | 0;
      state[3] = (state[3] + d) | 0;
    }
    var result = "";
    state.forEach(function (word) {
      for (var j = 0; j < 4; j += 1) result += ("0" + ((word >>> (j * 8)) & 255).toString(16)).slice(-2);
    });
    return result;
  }

  function chooseRussianFile(files) {
    if (!Array.isArray(files)) return null;
    var preferred = null;
    files.forEach(function (file) {
      if (!file || Number(file.translate) !== 4 || !file.eid || !file.hash) return;
      var quality = Number(file.quality);
      if (quality >= 1 && quality <= 4 && Math.floor(quality) === quality) {
        if (!preferred || quality > Number(preferred.quality)) preferred = file;
      }
    });
    return preferred;
  }

  function normalizeEpisodes(response) {
    var source = Array.isArray(response) ? response : response && response.episodes;
    if (!Array.isArray(source)) return [];
    var covers = response && Array.isArray(response.covers) ? response.covers : [];
    var seasonCovers = {};
    covers.forEach(function (cover) {
      if (cover && cover.season !== undefined) seasonCovers[String(cover.season)] = cover;
    });
    return source.filter(function (episode) {
      return episode && typeof episode === "object" && episode.season !== undefined && episode.episode !== undefined;
    }).map(function (episode) {
      var item = {};
      Object.keys(episode).forEach(function (key) { item[key] = episode[key]; });
      item.files = Array.isArray(episode.files) ? episode.files.slice() : [];
      if (!item.covers && seasonCovers[String(item.season)]) item.covers = seasonCovers[String(item.season)];
      return item;
    }).sort(function (left, right) {
      return Number(left.season) - Number(right.season) || Number(left.episode) - Number(right.episode);
    });
  }

  function parseMoviePlayer(html, mid) {
    var playerId = "movie_player_" + mid;
    var block = new RegExp('cache\\["' + playerId + '"\\]\\s*=\\s*new\\s+Playerjs\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)').exec(html);
    if (!block) {
      if (!/<form\b[^>]*\baction\s*=\s*(["'])\/logout\/?\1/i.test(html)) {
        throw apiError("SITE_AUTH_REQUIRED", "Для просмотра фильмов войдите в аккаунт ещё раз.", 401);
      }
      throw apiError("INVALID_RESPONSE", "Для этого фильма пока нет доступного видео.");
    }
    var file = /(?:^|[,\r\n])\s*file\s*:\s*("(?:[^"\\]|\\.)*")/.exec(block[1]);
    var title = /(?:^|[,\r\n])\s*title\s*:\s*("(?:[^"\\]|\\.)*")/.exec(block[1]);
    var stream, parsed, label = "";
    try {
      stream = file && JSON.parse(file[1]);
      if (typeof stream !== "string" || /[\s<>"']/.test(stream)) throw new Error();
      parsed = new root.URL(stream);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash ||
          !/^cdn-[a-z0-9-]+\.soap4youand\.me$/i.test(parsed.hostname) ||
          !/^\/hls\/.+\/master\.m3u8$/.test(parsed.pathname)) throw new Error();
      if (title) label = JSON.parse(title[1]);
    } catch (ignore) {
      throw apiError("INVALID_RESPONSE", "Сервис вернул неверную ссылку на фильм.");
    }
    return {ok: 1, stream: parsed.href, start_from: 0, title: label, audioLanguage: "ru"};
  }

  function hlsAttributes(value) {
    var attributes = Object.create(null);
    var pattern = /([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))(?:,|$)/g;
    var match;
    while ((match = pattern.exec(value))) {
      attributes[match[1]] = match[2] === undefined ? match[3].trim() : match[2];
    }
    return attributes;
  }

  function parseMovieManifest(manifest) {
    if (!/^\s*#EXTM3U(?:\r?\n|$)/.test(manifest)) {
      throw apiError("INVALID_RESPONSE", "Сервис вернул неверный плейлист фильма.");
    }
    var lines = manifest.split(/\r?\n/).map(function (line) { return line.trim(); });
    var russianGroups = Object.create(null);
    var audio = [];
    var subtitleCount = 0;
    var streamCount = 0;
    lines.forEach(function (line) {
      if (line.indexOf("#EXT-X-MEDIA:") !== 0) return;
      var attributes = hlsAttributes(line.slice(13));
      var russian = attributes.LANGUAGE ? /^(ru|rus)(?:-|$)/i.test(attributes.LANGUAGE) : /русск|russian/i.test(attributes.NAME || "");
      if (attributes.TYPE === "SUBTITLES") subtitleCount += 1;
      if (attributes.TYPE === "AUDIO") audio.push({russian: russian, uri: attributes.URI, group: attributes["GROUP-ID"]});
      if (attributes.TYPE === "AUDIO" && attributes["GROUP-ID"] && russian && !russianGroups[attributes["GROUP-ID"]]) {
        russianGroups[attributes["GROUP-ID"]] = attributes;
      }
    });
    var variants = [];
    lines.forEach(function (line, index) {
      if (line.indexOf("#EXT-X-STREAM-INF:") !== 0) return;
      streamCount += 1;
      var attributes = hlsAttributes(line.slice(18));
      if (attributes.SUBTITLES && attributes.SUBTITLES !== "NONE") subtitleCount += 1;
      var avc = (attributes.CODECS || "").split(",").some(function (codec) { return /^avc[13](?:\.[a-f0-9]+)?$/i.test(codec.trim()); });
      var resolution = /^(\d+)[xX](\d+)$/.exec(attributes.RESOLUTION || "");
      var bandwidth = Number(attributes.BANDWIDTH);
      var next = index + 1;
      while (next < lines.length && !lines[next]) next += 1;
      if (!avc || !resolution || !/^\d+$/.test(attributes.BANDWIDTH || "") ||
          bandwidth < 1 || bandwidth > 9007199254740991 || !lines[next] || /^[#]/.test(lines[next]) || /[\s<>"']/.test(lines[next])) return;
      var width = Number(resolution[1]);
      var height = Number(resolution[2]);
      if (width < 1 || height < 1 || width > 3840 || height > 2160) return;
      var russianAudio = russianGroups[attributes.AUDIO];
      variants.push({bandwidth: bandwidth, width: width, height: height, pixels: width * height,
        russian: !!russianAudio, uri: lines[next], audioUri: russianAudio && russianAudio.URI});
    });
    return {variants: variants, audio: audio, streamCount: streamCount, subtitleCount: subtitleCount};
  }

  function selectMovieVariant(parsed) {
    var variants = parsed.variants;
    if (!variants.length) throw apiError("NO_COMPATIBLE_VIDEO", "Для этого фильма пока нет подходящего видео.");
    var russianVariants = variants.filter(function (variant) { return variant.russian; });
    if (!russianVariants.length) throw apiError("NO_RUSSIAN_AUDIO", "Русская озвучка этого фильма недоступна.");
    russianVariants.sort(function (left, right) {
      // Prefer the largest AVC picture through 4K, then the highest bitrate.
      return right.pixels - left.pixels || right.bandwidth - left.bandwidth;
    });
    return russianVariants[0];
  }

  function movieChildUrl(uri, master, kind) {
    var parsed;
    try {
      if (typeof uri !== "string" || !uri || /[\s\x00-\x1f\x7f<>"'\\]/.test(uri)) throw new Error();
      var base = new root.URL(master);
      parsed = new root.URL(uri, base.href);
      if (parsed.protocol !== "https:" || parsed.origin !== base.origin || parsed.username || parsed.password || parsed.port || parsed.hash ||
          !/^cdn-[a-z0-9-]+\.soap4youand\.me$/i.test(parsed.hostname)) throw new Error();
      var filename = new RegExp("^(/(?:.*/)?)index-(f[1-9][0-9]*-" + kind + "[1-9][0-9]*)\\.m3u8$").exec(parsed.pathname);
      if (!filename) throw new Error();
      return {url: parsed, directory: filename[1], selector: filename[2]};
    } catch (ignore) {
      throw apiError("INVALID_RESPONSE", "Сервис вернул неверный плейлист фильма.");
    }
  }

  function filteredMovieMaster(variant, master) {
    var video = movieChildUrl(variant.uri, master, "v");
    var audio = movieChildUrl(variant.audioUri, master, "a");
    if (video.directory !== audio.directory || video.url.search !== audio.url.search) {
      throw apiError("INVALID_RESPONSE", "Сервис вернул несовместимые дорожки фильма.");
    }
    return video.url.origin + video.directory + "master-" + video.selector + "-" + audio.selector + ".m3u8" + video.url.search;
  }

  function validateFilteredMovie(manifest, expected, stream) {
    var parsed = parseMovieManifest(manifest);
    var selected = selectMovieVariant(parsed);
    if (parsed.streamCount !== 1 || parsed.variants.length !== 1 || parsed.audio.length !== 1 ||
        !parsed.audio[0].russian || parsed.subtitleCount || selected.width !== expected.width || selected.height !== expected.height) {
      throw apiError("NO_COMPATIBLE_VIDEO", "Для этого фильма пока нет подходящего видео.");
    }
    var video = movieChildUrl(selected.uri, stream, "v");
    var audio = movieChildUrl(selected.audioUri, stream, "a");
    var directory = new root.URL(stream).pathname.replace(/[^/]+$/, "");
    var expectedVideo = movieChildUrl(expected.uri, stream, "v");
    var expectedAudio = movieChildUrl(expected.audioUri, stream, "a");
    if (video.directory !== directory || audio.directory !== directory || video.url.search !== audio.url.search ||
        video.selector !== expectedVideo.selector || audio.selector !== expectedAudio.selector) {
      throw apiError("INVALID_RESPONSE", "Сервис вернул несовместимые дорожки фильма.");
    }
    return selected;
  }

  function SoapApi(options) {
    options = options || {};
    this.baseUrl = (options.baseUrl || "https://api.soap4youand.me/v2").replace(/\/+$/, "");
    this.siteBaseUrl = (options.siteBaseUrl || (this.baseUrl.charAt(0) === "/" ? "/site" : "https://soap4youand.me")).replace(/\/+$/, "");
    this.token = options.token || "";
    this.timeout = options.timeout || 20000;
  }

  SoapApi.prototype.getToken = function () { return this.token; };
  SoapApi.prototype.setToken = function (token) { this.token = typeof token === "string" ? token : ""; };

  SoapApi.prototype._request = function (method, path, form, anonymous, transport) {
    var self = this;
    transport = transport || {};
    return new Promise(function (resolve, reject) {
      if (!anonymous && !self.token) {
        reject(apiError("AUTH_REQUIRED", "Войдите в аккаунт Soap4me.", 401));
        return;
      }
      var xhr;
      try {
        xhr = new root.XMLHttpRequest();
        xhr.open(method, transport.url || (transport.site ? self.siteBaseUrl : self.baseUrl) + path, true);
        xhr.timeout = self.timeout;
        // Soap4me requires its session cookie in addition to X-API-TOKEN.
        xhr.withCredentials = !transport.public;
        xhr.setRequestHeader("Accept", transport.site || transport.raw ? "*/*" : "application/json");
        if (!anonymous && !transport.site && !transport.public) xhr.setRequestHeader("X-API-TOKEN", self.token);
        var body = null;
        if (form) {
          xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
          body = Object.keys(form).map(function (key) {
            return encodeURIComponent(key) + "=" + encodeURIComponent(String(form[key]));
          }).join("&");
        }
        xhr.onload = function () {
          var status = xhr.status;
          if (transport.site || transport.raw) {
            if (transport.site && (status === 401 || status === 403)) {
              reject(apiError("SITE_AUTH_REQUIRED", "Для просмотра фильмов войдите в аккаунт ещё раз.", status));
            } else if (status < 200 || status >= 300) {
              reject(apiError("HTTP_ERROR", "Сервис недоступен (HTTP " + status + "). Попробуйте ещё раз.", status));
            } else if (typeof xhr.responseText !== "string" || !xhr.responseText.trim()) {
              reject(apiError("INVALID_RESPONSE", "Сервис вернул неожиданный ответ.", status));
            } else resolve(xhr.responseText);
            return;
          }
          var response;
          try { response = JSON.parse(xhr.responseText); } catch (ignore) { response = null; }
          // Never forward the server body or native error: either can contain a token or stream URL.
          if (status === 401 || status === 403 || (response && (Number(response.code) === 401 || Number(response.code) === 403))) {
            reject(apiError("AUTH_REQUIRED", anonymous ? "Проверьте логин и пароль." : "Сессия истекла. Войдите ещё раз.", status || 401));
          } else if (status < 200 || status >= 300) {
            reject(apiError("HTTP_ERROR", "Сервис недоступен (HTTP " + status + "). Попробуйте ещё раз.", status));
          } else if (response === null || typeof response !== "object") {
            reject(apiError("INVALID_RESPONSE", "Сервис вернул неожиданный ответ.", status));
          } else if (Object.prototype.hasOwnProperty.call(response, "ok") && Number(response.ok) !== 1) {
            reject(apiError(anonymous ? "AUTH_REQUIRED" : "API_ERROR", anonymous ? "Проверьте логин и пароль." : "Сервис не смог выполнить запрос.", status));
          } else resolve(response);
        };
        xhr.onerror = function () { reject(apiError("NETWORK_ERROR", "Не удалось связаться с Soap4me. Проверьте подключение.")); };
        xhr.ontimeout = function () { reject(apiError("TIMEOUT", "Soap4me долго не отвечает. Попробуйте ещё раз.")); };
        xhr.onabort = function () { reject(apiError("ABORTED", "Запрос отменён.")); };
        xhr.send(body);
      } catch (ignore) {
        reject(apiError("NETWORK_ERROR", "Не удалось отправить запрос к Soap4me."));
      }
    });
  };

  SoapApi.prototype.login = function (login, password) {
    var self = this;
    if (typeof login !== "string" || !login.trim() || typeof password !== "string" || !password) {
      return Promise.reject(apiError("BAD_INPUT", "Введите логин и пароль."));
    }
    return this._request("POST", "/auth/", {login: login.trim(), password: password}, true).then(function (response) {
      if (Number(response.ok) !== 1 || typeof response.token !== "string" || !response.token) {
        throw apiError("INVALID_RESPONSE", "Не удалось получить сессию Soap4me.");
      }
      self.setToken(response.token);
      // Movies use the regular website's separate cookie. A temporary website
      // failure must not prevent series from working with a valid API session.
      return self._request("POST", "/login/", {login: login.trim(), password: password}, true, {site: true}).then(function () {
        return response;
      }, function () {
        return response;
      });
    });
  };

  function requireArray(response) {
    if (!Array.isArray(response)) throw apiError("INVALID_RESPONSE", "Не удалось прочитать каталог Soap4me.");
    return response;
  }

  function validNumber(value, allowZero) {
    return (typeof value === "string" || typeof value === "number") && /^\d+$/.test(String(value)) &&
      Number(value) >= (allowZero ? 0 : 1) && Number(value) <= 9007199254740991;
  }

  function requireMarked(response) {
    if (!response || (response.ok !== 1 && response.ok !== "1")) {
      throw apiError("INVALID_RESPONSE", "Сервис не подтвердил отметку просмотра.");
    }
    return response;
  }

  SoapApi.prototype.checkAuth = function () {
    return this._request("GET", "/auth/check/").then(function (response) {
      if (Number(response.logged) !== 1 && Number(response.loged) !== 1) {
        throw apiError("AUTH_REQUIRED", "Сессия истекла. Войдите ещё раз.", 401);
      }
      return response;
    });
  };

  SoapApi.prototype.getMyShows = function () { return this._request("GET", "/soap/my/").then(requireArray); };
  SoapApi.prototype.getAllShows = function () { return this._request("GET", "/soap/").then(requireArray); };
  SoapApi.prototype.getMovies = function () { return this._request("GET", "/movies/").then(requireArray); };
  SoapApi.prototype.getMoviePlayback = function (mid) {
    if (!validNumber(mid, false)) return Promise.reject(apiError("BAD_INPUT", "Не выбран фильм."));
    var self = this;
    return this._request("GET", "/movies/" + String(mid) + "/", null, false, {site: true}).then(function (html) {
      var playback = parseMoviePlayer(html, String(mid));
      return self._request("GET", "", null, true, {url: playback.stream, raw: true, public: true}).then(function (manifest) {
        var selected = selectMovieVariant(parseMovieManifest(manifest));
        var filtered = filteredMovieMaster(selected, playback.stream);
        return self._request("GET", "", null, true, {url: filtered, raw: true, public: true}).then(function (filteredManifest) {
          playback.hlsBitrate = validateFilteredMovie(filteredManifest, selected, filtered).bandwidth;
          playback.stream = filtered;
          return playback;
        });
      });
    });
  };
  SoapApi.prototype.markShowWatched = function (sid) {
    if (!validNumber(sid, false)) return Promise.reject(apiError("BAD_INPUT", "Не выбран сериал."));
    return this._request("POST", "/episodes/watch/full/" + String(sid) + "/", {sid: sid}).then(requireMarked);
  };
  SoapApi.prototype.markSeasonWatched = function (sid, season) {
    if (!validNumber(sid, false) || !validNumber(season, true)) {
      return Promise.reject(apiError("BAD_INPUT", "Не выбран сезон сериала."));
    }
    return this._request("POST", "/episodes/watch/full/" + String(sid) + "/" + String(season) + "/", {sid: sid, season: season}).then(requireMarked);
  };
  SoapApi.prototype.getEpisodes = function (sid) {
    if (sid === undefined || sid === null || String(sid) === "") return Promise.reject(apiError("BAD_INPUT", "Не выбран сериал."));
    return this._request("GET", "/episodes/" + encodeURIComponent(String(sid)) + "/").then(function (response) {
      if (!response || (!Array.isArray(response) && !response.episodes)) {
        throw apiError("INVALID_RESPONSE", "Не удалось прочитать список серий.");
      }
      return response;
    });
  };
  SoapApi.prototype.getPlayback = function (sid, file) {
    if (sid === undefined || sid === null || String(sid) === "" || !file || !file.eid || !file.hash) {
      return Promise.reject(apiError("BAD_INPUT", "Не выбран видеофайл."));
    }
    var signature = md5(this.token + String(file.eid) + String(sid) + String(file.hash));
    return this._request("POST", "/play/episode/" + encodeURIComponent(String(file.eid)) + "/", {eid: file.eid, hash: signature}).then(function (response) {
      if (typeof response.stream !== "string" || !/^https?:\/\//i.test(response.stream)) {
        throw apiError("INVALID_RESPONSE", "Сервис не вернул ссылку на видео.");
      }
      return response;
    });
  };

  SoapApi.md5 = md5;
  SoapApi.chooseRussianFile = chooseRussianFile;
  SoapApi.normalizeEpisodes = normalizeEpisodes;
  SoapApi.prototype.chooseRussianFile = chooseRussianFile;
  SoapApi.prototype.normalizeEpisodes = normalizeEpisodes;
  return SoapApi;
}));
