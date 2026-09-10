/* Small AVPlay adapter. Stream URLs and API credentials are never logged. */
(function (global) {
  'use strict';

  function element(id) { return document.getElementById(id); }
  function clock(milliseconds) {
    var seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    return (minutes >= 60 ? Math.floor(minutes / 60) + ':' + ('0' + minutes % 60).slice(-2) : minutes) + ':' + ('0' + remainder).slice(-2);
  }

  function SoapPlayer(options) {
    this.options = options || {};
    this.av = global.webapis && global.webapis.avplay;
    this.video = element('html-player');
    this.active = false;
    this.ready = false;
    this.paused = false;
    this.generation = 0;
    this.currentTime = 0;
    this.duration = 0;
    this.seekBusy = false;
    this.seekTarget = null;
    this.controlsTimer = null;
    this.controlsRevision = 0;
    this.prepareTimer = null;
    this.seekTimer = null;
    this.pendingSeek = null;
    this.pendingPause = null;
    this.releasePending = false;
    this.queuedStart = null;
    this.avOpen = false;
    this.qualityKnown = false;
  }

  SoapPlayer.prototype._screenSaver = function (enabled) {
    try {
      if (global.webapis && global.webapis.appcommon) {
        var common = global.webapis.appcommon;
        common.setScreenSaver(enabled ? common.AppCommonScreenSaverState.SCREEN_SAVER_ON : common.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
      }
    } catch (ignored) { /* Older firmware may not expose this optional API. */ }
  };

  SoapPlayer.prototype.showControls = function () {
    var self = this;
    var revision = ++this.controlsRevision;
    var generation = this.generation;
    clearTimeout(this.controlsTimer);
    element('player-controls').hidden = false;
    element('player-controls').style.opacity = '1';
    if (this.active && this.ready && !(this.pendingPause === null ? this.paused : this.pendingPause)) {
      this.controlsTimer = setTimeout(function () {
        if (self.active && self.ready && self.generation === generation && self.controlsRevision === revision &&
            !(self.pendingPause === null ? self.paused : self.pendingPause)) element('player-controls').style.opacity = '0';
      }, 4500);
    }
  };

  SoapPlayer.prototype._buffering = function (active, message) {
    if (!this.active) return;
    element('player-buffering').hidden = !active;
    element('player-status').textContent = message || 'Загрузка видео…';
  };

  SoapPlayer.prototype._time = function (current) {
    this.currentTime = Number(current) || 0;
    var displayTime = this.seekTarget === null ? this.currentTime : this.seekTarget;
    element('player-time').textContent = clock(displayTime) + ' / ' + clock(this.duration);
    element('player-progress').style.width = (this.duration ? Math.min(100, displayTime / this.duration * 100) : 0) + '%';
  };

  SoapPlayer.prototype._updateQuality = function () {
    if (!this.active || !this.ready || this.pendingSeek || this.qualityKnown) return;
    var width;
    var height;
    try {
      if (this.av) {
        var tracks = this.av.getCurrentStreamInfo();
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i].type !== 'VIDEO') continue;
          var info = tracks[i].extra_info || {};
          if (typeof info === 'string') {
            try { info = JSON.parse(info); } catch (ignored) { continue; }
          }
          if (!info) continue;
          width = Number(info.Width || info.width);
          height = Number(info.Height || info.height);
          break;
        }
      } else {
        width = Number(this.video.videoWidth);
        height = Number(this.video.videoHeight);
      }
      if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return;
      width = Math.round(width);
      height = Math.round(height);
      // Wide cinema releases retain their nominal width with cropped height.
      var quality = width >= 3840 || height >= 2160 ? '4K' :
        width >= 1920 || height >= 1080 ? 'Full HD' :
        width >= 1280 || height >= 720 ? '720p' : 'SD';
      element('player-label').textContent = 'РУССКАЯ ОЗВУЧКА · ' + quality + ' · ' + width + '×' + height;
      this.qualityKnown = true;
    } catch (ignored) { /* Decoder metadata can arrive after the first playback callback. */ }
  };

  SoapPlayer.prototype._preferRussianAudio = function () {
    if (!this.av) return;
    try {
      var tracks = this.av.getTotalTrackInfo();
      for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].type !== 'AUDIO') continue;
        var info = tracks[i].extra_info || {};
        if (typeof info === 'string') {
          try { info = JSON.parse(info); } catch (ignored) { info = {}; }
        }
        var language = String(info.language || info.track_lang || info.lang || '').toLowerCase();
        if (/^(ru|rus|russian|русский)([-_]|$)/.test(language)) {
          this.av.setSelectTrack('AUDIO', Number(tracks[i].index));
          break;
        }
      }
    } catch (ignored) { /* translate=4 is already selected; not all tracks include a language. */ }
  };

  SoapPlayer.prototype._releaseAv = function () {
    if (!this.av || !this.avOpen) return;
    try {
      var state = this.av.getState();
      if (state === 'PLAYING' || state === 'PAUSED' || state === 'READY') this.av.stop();
    } catch (ignored) { /* close also releases failed prepares. */ }
    try { this.av.close(); } catch (ignored) { /* The platform may have already closed it. */ }
    this.avOpen = false;
    this.releasePending = false;
  };

  SoapPlayer.prototype._seekAv = function (target, success, failure) {
    var self = this;
    var operation = {};
    this.pendingSeek = operation;
    var finish = function (failed) {
      if (self.pendingSeek !== operation) return;
      self.pendingSeek = null;
      // Samsung forbids other AVPlay calls until seekTo finishes. Back can hide
      // the view immediately, but close and a subsequent open must wait here.
      if (self.releasePending) {
        self._releaseAv();
        var queued = self.queuedStart;
        self.queuedStart = null;
        if (queued && self.active) self.start(queued.playback, queued.title);
        return;
      }
      if (failed) failure(); else success();
      if (self.pendingPause !== null && self.active && self.ready) {
        var desired = self.pendingPause;
        self.pendingPause = null;
        self.setPaused(desired);
      }
    };
    try { this.av.seekTo(target, function () { finish(false); }, function () { finish(true); }); }
    catch (error) { finish(true); }
  };

  SoapPlayer.prototype.start = function (playback, title) {
    this.stop(false);
    this.qualityKnown = false;
    element('player-label').textContent = 'РУССКАЯ ОЗВУЧКА';
    var self = this;
    var generation = this.generation;
    var current = function () { return self.active && self.generation === generation; };
    var fail = function () {
      if (current()) self.stop(true, 'Не удалось воспроизвести видео. Попробуйте открыть его ещё раз.');
    };
    if (!playback || !/^https?:\/\//i.test(playback.stream || '')) {
      if (this.options.onStop) this.options.onStop('Сервис не вернул ссылку на видео.');
      return;
    }
    this.active = true;
    element('player-view').hidden = false;
    element('player-title').textContent = title || playback.title || 'Просмотр';
    element('player-state').textContent = 'Подготовка';
    this._time(0);
    this._buffering(true);
    this.showControls();
    if (this.options.onStart) this.options.onStart();
    this._screenSaver(false);
    this.prepareTimer = setTimeout(function () {
      if (current() && !self.ready) self.stop(true, 'Видео слишком долго загружается. Проверьте сеть и попробуйте ещё раз.');
    }, 45000);

    if (this.av && this.pendingSeek) {
      this.queuedStart = { playback: playback, title: title };
      return;
    }

    var resumeAt = Math.max(0, Number(playback.start_from) || 0) * 1000;
    if (this.av) {
      element('av-player').hidden = false;
      this.video.hidden = true;
      try {
        this.av.open(playback.stream);
        this.avOpen = true;
        if (typeof playback.hlsBitrate === 'number' && isFinite(playback.hlsBitrate) && playback.hlsBitrate > 0 && Math.floor(playback.hlsBitrate) === playback.hlsBitrate) {
          // Keep the master playlist for its Russian audio group, but pin the
          // selected AVC rendition. Automatic HEVC selection on this Tizen 5.5
          // TV played the movie yet left every seek stuck in buffering.
          var bitrate = playback.hlsBitrate;
          this.av.setStreamingProperty('ADAPTIVE_INFO', 'BITRATES=' + Math.max(1, bitrate - 100) + '~' + (bitrate + 100) + '|STARTBITRATE=' + bitrate);
        }
        this.av.setListener({
          onbufferingstart: function () { if (current()) self._buffering(true); },
          onbufferingprogress: function (percent) { if (current()) self._buffering(true, 'Загрузка видео… ' + Math.round(percent) + '%'); },
          onbufferingcomplete: function () { if (current()) self._buffering(false); },
          oncurrentplaytime: function (time) {
            if (!current()) return;
            self._time(time);
            self._updateQuality();
          },
          onstreamcompleted: function () { if (current()) self.stop(true, undefined, 'ended'); },
          onerror: fail,
          onerrormsg: fail,
          onsubtitlechange: function () { /* Subtitles intentionally remain hidden. */ }
        });
        this.av.setDisplayRect(0, 0, 1920, 1080);
        this.av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        try { this.av.setSilentSubtitle(true); } catch (ignored) { /* No subtitle URLs are supplied. */ }
        this.av.prepareAsync(function () {
          if (!current()) return;
          try {
            self.duration = Number(self.av.getDuration()) || 0;
            var play = function () {
              if (!current()) return;
              try {
                self.av.play();
                self.ready = true;
                self._buffering(false);
                clearTimeout(self.prepareTimer);
                self._preferRussianAudio();
                try { self.av.setSilentSubtitle(true); } catch (ignored) { /* Already disabled before prepare. */ }
                element('player-state').textContent = 'Воспроизведение';
                self.showControls();
              } catch (error) { fail(); }
            };
            if (resumeAt > 0 && resumeAt < self.duration - 3000) self._seekAv(Math.floor(resumeAt), play, play);
            else play();
          } catch (error) { fail(); }
        }, fail);
      } catch (error) { fail(); }
    } else {
      element('av-player').hidden = true;
      this.video.hidden = false;
      this.video.onloadedmetadata = function () {
        if (!current()) return;
        self.duration = Number(self.video.duration) * 1000 || 0;
        if (resumeAt > 0 && resumeAt < self.duration - 3000) self.video.currentTime = resumeAt / 1000;
        for (var i = 0; i < self.video.textTracks.length; i++) self.video.textTracks[i].mode = 'disabled';
      };
      this.video.onplaying = function () {
        if (!current()) return;
        self.ready = true;
        self.paused = false;
        clearTimeout(self.prepareTimer);
        self._buffering(false);
        element('player-state').textContent = 'Воспроизведение';
        self.showControls();
      };
      this.video.onwaiting = function () { if (current()) self._buffering(true); };
      this.video.ontimeupdate = function () {
        if (!current()) return;
        self._time(self.video.currentTime * 1000);
        self._updateQuality();
      };
      this.video.onended = function () { if (current()) self.stop(true, undefined, 'ended'); };
      this.video.onerror = fail;
      this.video.src = playback.stream;
      try {
        var promise = this.video.play();
        if (promise && promise.catch) promise.catch(fail);
      } catch (error) { fail(); }
    }
  };

  SoapPlayer.prototype.setPaused = function (paused) {
    if (!this.active || !this.ready) return;
    if (this.pendingSeek) {
      this.pendingPause = paused;
      element('player-state').textContent = paused ? 'Пауза' : 'Воспроизведение';
      this.showControls();
      return;
    }
    if (this.paused === paused) return;
    try {
      if (this.av) {
        if (paused) this.av.pause(); else this.av.play();
      } else {
        if (paused) this.video.pause();
        else {
          var self = this;
          var generation = this.generation;
          var promise = this.video.play();
          if (promise && promise.catch) promise.catch(function () {
            if (self.active && self.generation === generation) self.stop(true, 'Не удалось продолжить воспроизведение.');
          });
        }
      }
      this.paused = paused;
      this._screenSaver(paused);
      element('player-state').textContent = paused ? 'Пауза' : 'Воспроизведение';
      this.showControls();
    } catch (error) { this.stop(true, 'Плеер не отвечает. Откройте видео ещё раз.'); }
  };

  SoapPlayer.prototype.seek = function (delta) {
    if (!this.active || !this.ready || !this.duration) return;
    var self = this;
    var generation = this.generation;
    var from = this.seekTarget === null ? this.currentTime : this.seekTarget;
    this.seekTarget = Math.max(0, Math.min(this.duration - 1000, from + delta));
    this._time(this.currentTime);
    this.showControls();
    clearTimeout(this.seekTimer);
    // Coalesce held remote keys, and never issue overlapping AVPlay seeks.
    var applySeek = function () {
      if (!self.active || self.generation !== generation || self.seekTarget === null) return;
      if (self.seekBusy) { self.seekTimer = setTimeout(applySeek, 150); return; }
      var target = self.seekTarget;
      self.seekBusy = true;
      var done = function () {
        if (!self.active || self.generation !== generation) return;
        self.seekBusy = false;
        if (self.seekTarget === target) self.seekTarget = null;
        self._time(target);
      };
      var failed = function () {
        if (!self.active || self.generation !== generation) return;
        self.seekBusy = false;
        self.seekTarget = null;
        self._time(self.currentTime);
        if (self.options.onNotice) self.options.onNotice('Перемотка пока недоступна. Попробуйте ещё раз.');
      };
      try {
        if (self.av) self._seekAv(Math.floor(target), done, failed);
        else { self.video.currentTime = target / 1000; done(); }
      } catch (error) { failed(); }
    };
    this.seekTimer = setTimeout(applySeek, 250);
  };

  SoapPlayer.prototype.handleKey = function (code) {
    if (!this.active) return false;
    if (code === 10009 || code === 27 || code === 413) this.stop(true);
    else if (code === 13 || code === 32 || code === 10252) this.setPaused(!(this.pendingPause === null ? this.paused : this.pendingPause));
    else if (code === 415) this.setPaused(false);
    else if (code === 19) this.setPaused(true);
    else if (code === 37 || code === 412) this.seek(code === 412 ? -30000 : -10000);
    else if (code === 39 || code === 417) this.seek(code === 417 ? 30000 : 10000);
    else if (code === 38 || code === 40 || code === 457) this.showControls();
    else return false;
    return true;
  };

  SoapPlayer.prototype.stop = function (notify, message, reason) {
    var wasActive = this.active;
    this.generation++;
    this.controlsRevision++;
    this.active = false;
    this.ready = false;
    this.paused = false;
    this.seekBusy = false;
    this.seekTarget = null;
    this.pendingPause = null;
    this.queuedStart = null;
    this.duration = 0;
    this.currentTime = 0;
    clearTimeout(this.controlsTimer);
    clearTimeout(this.prepareTimer);
    clearTimeout(this.seekTimer);
    if (this.av && this.avOpen) {
      if (this.pendingSeek) this.releasePending = true;
      else this._releaseAv();
    }
    this.video.onloadedmetadata = null;
    this.video.onplaying = null;
    this.video.onwaiting = null;
    this.video.ontimeupdate = null;
    this.video.onended = null;
    this.video.onerror = null;
    if (!this.av && wasActive) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    element('player-view').hidden = true;
    this._screenSaver(true);
    if (notify && this.options.onStop) this.options.onStop(message, reason);
  };

  global.SoapPlayer = SoapPlayer;
}(window));
