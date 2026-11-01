(function () {
  'use strict';

  var PAGE_SIZE = 21;
  var EPISODE_PAGE_SIZE = 16;
  var appVersion = '';
  var config = window.SOAP_CONFIG || {};
  var TOKEN_KEY = 'soap4samsung.token';
  var MY_SORT_KEY = 'soap4samsung.my-sort';
  var MOVIES_SORT_KEY = 'soap4samsung.movies-sort';
  var ALL_SORT_KEY = 'soap4samsung.all-sort';
  var mySort = 'unwatched';
  var moviesSort = 'year';
  var allSort = 'title';
  var sortTrigger = null;
  var sortEnterDown = false;
  var backDown = false;
  var SORT_LABELS = { unwatched: 'Сначала непросмотренные', title: 'По названию', year: 'По году: новые', imdb: 'По рейтингу IMDb', kinopoisk: 'По рейтингу КП', soap: 'По рейтингу Soap' };
  var api;
  var player;
  var keyboard;
  var requestGeneration = 0;
  var playbackGeneration = 0;
  var playPending = false;
  var toastTimer;
  var lastBack = 0;
  var lastShowFocus = null;
  var lastEpisodeFocus = null;
  var playingEpisode = null;
  var loginDestination = null;
  var store;
  var currentMedia = null;
  var freshShows = {};
  var writeErrorShown = false;
  var showPositions = {};
  var moviesFilter = storageGet('soap4samsung.movies-filter') === 'favorites';
  var pageChangedAt = -Infinity;
  var okHold = null;
  var confirmAction = null;
  var state = { tab: 'my', detail: null, my: { shows: null, query: '', page: 0 }, all: { shows: null, query: '', page: 0 }, movies: { shows: null, query: '', page: 0 } };

  function el(id) { return document.getElementById(id); }
  function node(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function clear(item) { while (item.firstChild) item.removeChild(item.firstChild); }
  function storageGet(key) { try { return localStorage.getItem(key); } catch (ignored) { return null; } }
  function storageSet(key, value) {
    try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); return true; } catch (ignored) { return false; }
  }
  function toast(message) {
    if (!message) return;
    clearTimeout(toastTimer);
    el('toast').textContent = message;
    el('toast').hidden = false;
    toastTimer = setTimeout(function () { el('toast').hidden = true; }, 5500);
  }
  function focus(item) {
    if (!item || (keyboard && keyboard.active)) return;
    if (sortTrigger && !el('sort-menu').contains(item)) return;
    if (confirmAction && confirmAction.item !== item) cancelConfirmation();
    item.focus();
    try { item.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (ignored) { /* Focus still works on older engines. */ }
  }
  function focusKey(key, fallback) {
    var items = document.querySelectorAll('[data-focus]');
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-focus') === key && !items[i].disabled) { focus(items[i]); return; }
    }
    focus(fallback || el('content').querySelector('button:not(:disabled)') || el('nav-' + state.tab));
  }
  function button(label, className, handler, key) {
    var item = node('button', className, label);
    item.type = 'button';
    item.addEventListener('click', handler);
    if (key) item.setAttribute('data-focus', key);
    return item;
  }
  function title(show) { return window.SoapCatalog.title(show); }
  function showId(show) { return show.sid; }
  function qualityLabel(file) { return ({ 1: 'SD', 2: '720p', 3: 'Full HD', 4: '4K' })[Number(file.quality)] || 'Видео'; }
  function russianFile(files) { return api.chooseRussianFile(files); }
  function episodeTitle(episode) { return String(episode.title_ru || episode.title_en || episode.title || 'Серия ' + episode.episode); }
  function episodeFocus(episode) { return 'episode-' + episode.season + '-' + episode.episode; }
  function poster(cover, fallbackText) {
    var item = node('span', 'poster');
    var fallback = node('span', 'poster-fallback', fallbackText);
    item.appendChild(fallback);
    if (typeof cover === 'string' && /^https?:\/\//i.test(cover)) {
      var image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.onload = function () { fallback.hidden = true; };
      image.onerror = function () { image.hidden = true; };
      image.src = cover;
      item.appendChild(image);
    }
    return item;
  }
  function sortShows(shows, tab) {
    var mode = tab === 'my' ? mySort : tab === 'movies' ? moviesSort : allSort;
    if (mode !== 'unwatched') return window.SoapCatalog.sort(shows, mode);
    return window.SoapCatalog.sort(shows.map(function (show) {
      var copy = Object.assign({}, show);
      copy.unwatched = store.adjustedUnwatched(show);
      copy.original = show;
      return copy;
    }), mode).map(function (show) { return show.original; });
  }
  function updateSortButton() {
    el('sort-my').textContent = SORT_LABELS[mySort] + ' ▾';
    el('sort-movies').textContent = SORT_LABELS[moviesSort] + ' ▾';
    el('sort-all').textContent = SORT_LABELS[allSort] + ' ▾';
  }
  function closeSort(restoreFocus) {
    var trigger = sortTrigger;
    sortTrigger = null;
    el('sort-menu').hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (trigger && restoreFocus) focus(trigger);
    if (restoreFocus) flushLibrary();
  }
  function openSort() {
    if (sortTrigger) { closeSort(true); return; }
    var tab = state.tab;
    var current = tab === 'my' ? mySort : tab === 'movies' ? moviesSort : allSort;
    var modes = tab === 'my' ? ['unwatched', 'title', 'year', 'imdb', 'kinopoisk', 'soap'] : ['title', 'year', 'imdb', 'kinopoisk', 'soap'];
    var menu = el('sort-menu');
    clear(menu);
    sortTrigger = el('sort-' + tab);
    sortTrigger.setAttribute('aria-expanded', 'true');
    var selected;
    modes.forEach(function (mode) {
      var option = button(SORT_LABELS[mode], 'sort-option', function () {
        if (tab === 'my') mySort = mode;
        else if (tab === 'movies') moviesSort = mode;
        else allSort = mode;
        storageSet(tab === 'my' ? MY_SORT_KEY : tab === 'movies' ? MOVIES_SORT_KEY : ALL_SORT_KEY, mode);
        state[tab].page = 0;
        updateSortButton();
        if (state[tab].shows) {
          state[tab].shows = sortShows(state[tab].shows, tab);
          renderShows(null, true);
        }
        closeSort(true);
      }, 'sort-option-' + mode);
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', mode === current ? 'true' : 'false');
      menu.appendChild(option);
      if (mode === current) selected = option;
    });
    menu.hidden = false;
    focus(selected || menu.firstChild);
  }
  function sortKey(event, code) {
    if (!sortTrigger) return false;
    if (code === 27 || code === 10009) closeSort(true);
    else if ((code >= 37 && code <= 40) || code === 9) {
      var options = Array.prototype.slice.call(el('sort-menu').querySelectorAll('button'));
      var index = options.indexOf(document.activeElement);
      var direction = code === 37 || code === 38 || (code === 9 && event.shiftKey) ? -1 : 1;
      focus(options[(index + direction + options.length) % options.length]);
    } else return false;
    event.preventDefault();
    return true;
  }
  function ratingBadges(show) {
    var badges = window.SoapCatalog.ratingBadges(show);
    if (!badges.length) return null;
    var group = node('span', 'rating-badges');
    badges.slice(0, 2).forEach(function (rating) {
      var badge = node('span', 'rating-badge rating-' + rating.source);
      badge.appendChild(node('span', 'rating-source', rating.label));
      badge.appendChild(node('span', 'rating-value', rating.text));
      badge.setAttribute('aria-label', (rating.source === 'kinopoisk' ? 'Кинопоиск' : rating.source === 'soap' ? 'Soap4me' : 'IMDb') + ': ' + rating.text + ' из 10');
      group.appendChild(badge);
    });
    return group;
  }
  function episodeMedia(episode, detail) {
    return { kind: 'episode', sid: showId((detail || state.detail).show), season: episode.season, episode: episode.episode };
  }
  function movieMedia(movie) { return { kind: 'movie', id: movie.id }; }
  function watched(episode) { return store.effectiveWatched(episodeMedia(episode), episode.watched); }
  function saveProgress(snapshot) {
    if (snapshot && currentMedia) store.saveProgress(currentMedia.media, snapshot, currentMedia.card);
  }
  function beginMedia(media, card, playback, fromStart) {
    playback.start_from = fromStart === true ? 0 : store.resumeMs(media, playback.start_from) / 1000;
    currentMedia = Object.freeze({media: Object.freeze(media), card: Object.freeze(window.SoapStore.card(media.kind === 'movie' ? 'movie' : 'show', card))});
  }
  function selectedEpisodes(scope) {
    var detail = state.detail;
    return (detail.episodes || []).filter(function (episode) { return scope === 'show' || String(episode.season) === detail.season; });
  }
  function updateDetailActions() {
    var detail = state.detail;
    if (!detail || detail.kind === 'movie') return;
    ['show', 'season'].forEach(function (scope) {
      var episodes = selectedEpisodes(scope);
      var allWatched = episodes.length > 0 && episodes.every(watched);
      el('mark-' + scope).disabled = !episodes.length;
      el('mark-' + scope).textContent = allWatched ? 'Снять отметку ' + (scope === 'show' ? 'сериала' : 'сезона') : 'Отметить ' + (scope === 'show' ? 'сериал' : 'сезон') + ' просмотренным';
    });
  }
  function plainDescription(value) {
    // Metadata may contain HTML; parse only into an inert template, never insert it.
    var template = document.createElement('template');
    template.innerHTML = String(value || '');
    return (template.content.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function errorText(error) {
    if (error && (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT' || error.status === 0)) return 'Не удалось связаться с Soap4me. Проверьте подключение и повторите попытку.';
    return 'Не удалось загрузить данные Soap4me. Попробуйте ещё раз.';
  }
  function isAuthError(error) { return error && (error.code === 'AUTH_REQUIRED' || error.status === 401 || error.status === 403); }

  function showLogin(message) {
    closeSort(false);
    closeMore(false);
    if (keyboard) keyboard.close(false, false);
    requestGeneration++;
    playbackGeneration++;
    playPending = false;
    playingEpisode = null;
    el('busy-overlay').hidden = true;
    saveProgress(player.snapshot());
    player.stop(false);
    currentMedia = null;
    document.body.classList.remove('playing');
    document.documentElement.classList.remove('playing');
    el('app-shell').hidden = false;
    el('login-view').hidden = false;
    el('library-view').hidden = true;
    el('navigation').hidden = true;
    el('account').hidden = true;
    el('login-error').textContent = message || '';
    focus(el('login-name'));
  }

  function handleAuth(error) {
    if (error && error.code === 'SITE_AUTH_REQUIRED') {
      loginDestination = state.detail && state.detail.kind === 'movie' ? { movie: state.detail.show } : null;
      showLogin('Для просмотра фильмов войдите ещё раз.');
      return true;
    }
    if (!isAuthError(error)) return false;
    api.setToken('');
    storageSet(TOKEN_KEY, null);
    showLogin('Сессия закончилась. Войдите ещё раз.');
    return true;
  }

  function login(event) {
    event.preventDefault();
    var loginName = el('login-name').value.trim();
    var password = el('login-password').value;
    if (!loginName || !password || el('login-submit').disabled) return;
    el('login-submit').disabled = true;
    el('login-submit').textContent = 'Входим…';
    el('login-error').textContent = '';
    api.login(loginName, password).then(function () {
      el('login-password').value = '';
      if (!storageSet(TOKEN_KEY, api.getToken())) toast('Вход выполнен. Сохранить его на этом устройстве не удалось.');
      state.my.shows = null;
      state.all.shows = null;
      state.movies.shows = null;
      state.detail = null;
      var destination = loginDestination;
      loginDestination = null;
      if (destination && destination.movie) { state.tab = 'movies'; openMovie(destination.movie); }
      else openLibrary('my');
    }).catch(function (error) {
      el('login-password').value = '';
      el('login-error').textContent = isAuthError(error) ? 'Не удалось войти. Проверьте логин и пароль.' : errorText(error);
      focus(el('login-password'));
    }).then(function () {
      el('login-submit').disabled = false;
      el('login-submit').textContent = 'Войти';
    });
  }

  function loading() {
    clear(el('content'));
    clear(el('pagination'));
    var item = node('div', 'loading-state');
    item.appendChild(node('div', 'spinner'));
    item.appendChild(node('span', '', 'Загружаем…'));
    el('content').appendChild(item);
  }

  function empty(heading, text, retry) {
    clear(el('content'));
    clear(el('pagination'));
    var item = node('div', 'empty-state');
    item.appendChild(node('h2', '', heading));
    item.appendChild(node('p', '', text));
    if (retry) item.appendChild(button('Повторить', 'primary-button', retry, 'retry'));
    el('content').appendChild(item);
  }

  function libraryHeading() {
    closeSort(false);
    el('login-view').hidden = true;
    el('library-view').hidden = false;
    el('navigation').hidden = false;
    el('account').hidden = false;
    ['my', 'all', 'movies', 'settings'].forEach(function (tab) {
      el('nav-' + tab).classList.toggle('active', state.tab === tab);
      el('nav-' + tab).setAttribute('aria-current', state.tab === tab ? 'page' : 'false');
    });
    el('search-box').hidden = !!state.detail || state.tab === 'settings';
    el('library-tools').hidden = !!state.detail || state.tab === 'settings';
    el('movies-filter').hidden = state.tab !== 'movies';
    el('movies-filter').textContent = moviesFilter ? 'Избранные' : 'Все';
    el('sort-my').hidden = !!state.detail || state.tab !== 'my';
    el('sort-movies').hidden = !!state.detail || state.tab !== 'movies';
    el('sort-all').hidden = !!state.detail || state.tab !== 'all';
    updateSortButton();
    updateDetailActions();
    el('section-title').textContent = state.detail ? title(state.detail.show) : state.tab === 'my' ? 'Избранное' : state.tab === 'movies' ? 'Фильмы' : state.tab === 'settings' ? 'Настройки' : 'Сериалы';
    updateSearchButton();
  }

  function updateSearchButton() {
    var query = state[state.tab] ? state[state.tab].query : '';
    el('search').textContent = query || 'Поиск по названию';
    el('search').classList.toggle('has-query', !!query);
    el('search').setAttribute('aria-label', query ? 'Поиск: ' + query + '. Изменить запрос' : 'Поиск по названию');
  }

  function rememberShow() {
    if (state.detail && state.detail.kind === 'show') showPositions[String(showId(state.detail.show))] = {season: state.detail.season, page: state.detail.page};
  }
  function openLibrary(tab, force, restoreFocus) {
    rememberShow();
    closeMore(false);
    state.tab = tab;
    state.detail = null;
    var generation = ++requestGeneration;
    var data = state[tab];
    if (data) data.request = generation;
    libraryHeading();
    if (tab === 'settings') { renderSettings(); return; }
    if (tab === 'my') {
      data.shows = sortShows(store.favorites('show'), tab);
      if (data.shows.length) renderShows(restoreFocus);
      else loading();
    } else if (!force && data.shows) { renderShows(restoreFocus); return; }
    else loading();
    var token = api.getToken();
    var request = tab === 'my' ? api.getMyShows() : tab === 'movies' ? api.getMovies() : api.getAllShows();
    request.then(function (shows) {
      if (token !== api.getToken() || data.request !== generation) return;
      shows = Array.isArray(shows) ? shows : [];
      if (tab === 'my') store.importFavoritesOnce(shows);
      store.refreshCards(tab === 'movies' ? 'movie' : 'show', shows);
      if (tab !== 'movies') shows.forEach(function (show) {
        if (tab === 'my' || !freshShows[show.sid] || show.unwatched !== undefined) freshShows[show.sid] = show;
      });
      data.shows = sortShows(tab === 'my' ? store.favorites('show') : shows, tab);
      if (generation !== requestGeneration || state.tab !== tab || state.detail) return;
      if (player.active || playPending || sortTrigger || okHold || keyboard.active) { data.backgroundReady = true; return; }
      var activeKey = document.activeElement && document.activeElement.getAttribute('data-focus');
      var keepFocus = !!el('content').querySelector('.show-grid') || !!activeKey;
      renderShows(activeKey || restoreFocus, keepFocus);
      if (activeKey) focusKey(activeKey);
    }).catch(function (error) {
      if (generation !== requestGeneration) return;
      // Cached favorites remain usable when their background refresh fails.
      if (tab === 'my' && data.shows.length) return;
      if (handleAuth(error)) return;
      el('section-summary').textContent = '';
      empty('Не получилось загрузить каталог', errorText(error), function () { openLibrary(tab, true); });
      focusKey('retry');
    });
  }

  function pageInfo(total, page, firstSize, size) {
    size = size || PAGE_SIZE;
    firstSize = firstSize || size;
    var pages = total <= firstSize ? 1 : 1 + Math.ceil((total - firstSize) / size);
    page = Math.max(0, Math.min(page, pages - 1));
    return {page: page, pages: pages, start: page ? firstSize + (page - 1) * size : 0, size: page ? size : firstSize};
  }
  function pagination(info, change) {
    var container = el('pagination');
    clear(container);
    if (info.pages <= 1) return;
    var previous = button('‹', 'page-indicator', function () { if (info.page > 0) change(info.page - 1); });
    var next = button('›', 'page-indicator', function () { if (info.page < info.pages - 1) change(info.page + 1); });
    previous.tabIndex = next.tabIndex = -1;
    previous.setAttribute('aria-label', 'Предыдущая страница');
    next.setAttribute('aria-label', 'Следующая страница');
    container.appendChild(previous);
    container.appendChild(node('span', '', (info.page + 1) + ' / ' + info.pages));
    container.appendChild(next);
  }
  function progressBar(record, className) {
    if (!record || !record.durationMs || !record.positionMs) return null;
    var track = node('span', className || 'card-progress');
    var fill = node('span');
    fill.style.width = Math.min(100, record.positionMs / record.durationMs * 100) + '%';
    track.appendChild(fill);
    return track;
  }
  function appendProgress(item, record, className) {
    var bar = progressBar(record, className);
    if (bar) item.appendChild(bar);
  }
  function favoriteLabel(kind, show) { return store.isFavorite(kind, kind === 'movie' ? show.id : show.sid) ? 'Убрать из избранного' : 'В избранное'; }
  function toggleFavorite(kind, show) {
    store.toggleFavorite(kind, show);
    if (state.detail) {
      if (state.detail.kind === 'movie') renderMovie('detail-favorite');
      else renderEpisodes('detail-favorite');
    } else {
      var key = document.activeElement && document.activeElement.getAttribute('data-focus');
      if (state.tab === 'my') state.my.shows = sortShows(store.favorites('show'), 'my');
      renderShows(key);
    }
  }
  function cardButton(show, isMovie, continued) {
    var kind = isMovie ? 'movie' : 'show';
    var key = (continued ? 'continue-' : '') + kind + '-' + (isMovie ? show.id : show.sid);
    var card = button('', 'show-card' + (continued ? ' continue-card' : ''), function () {
      lastShowFocus = key;
      if (isMovie) openMovie(show); else openShow(show, !!continued);
    }, key);
    card.setAttribute('data-context', 'card');
    card.contextAction = function () { openContext(card, [{label: favoriteLabel(kind, show), action: function () { toggleFavorite(kind, show); }}]); };
    card.setAttribute('aria-label', title(show));
    card.appendChild(poster(show.covers && show.covers.small, title(show).slice(0, 1)));
    var copy = node('span', 'show-copy');
    copy.appendChild(node('span', 'show-title', title(show)));
    if (continued) {
      var record = continued.record;
      if (!isMovie) copy.appendChild(node('span', 'show-meta', (record.status === 'watched' ? 'После ' : '') + 'S' + continued.media.season + 'E' + continued.media.episode));
      copy.appendChild(node('span', 'show-meta', record.status === 'watched' ? 'Следующая серия' : 'Осталось ' + Math.ceil((record.durationMs - record.positionMs) / 60000) + ' мин'));
      card.appendChild(copy);
      appendProgress(card, record);
      return card;
    }
    var ratings = ratingBadges(show);
    if (ratings) card.appendChild(ratings);
    var flags = node('span', 'card-flags');
    // In Favorites every card is a favorite, so the mark would only add noise.
    // The catalog reports unwatched 0 for shows nobody started: only watching ones count.
    if (state.tab !== 'my' && store.isFavorite(kind, isMovie ? show.id : show.sid)) flags.appendChild(node('span', 'card-flag flag-favorite'));
    if (isMovie ? store.effectiveWatched(movieMedia(show), show.watched) : Number(show.watching) > 0 && store.adjustedUnwatched(show) === 0) flags.appendChild(node('span', 'card-flag flag-watched'));
    if (flags.firstChild) card.appendChild(flags);
    var meta = [];
    var count = isMovie ? 0 : store.adjustedUnwatched(show);
    if (show.year) meta.push(show.year);
    if (count) meta.push('Новых: ' + count);
    copy.appendChild(node('span', 'show-meta', meta.join(' · ')));
    card.appendChild(copy);
    appendProgress(card, isMovie ? store.get(movieMedia(show)) : store.nextEpisodeLabel(showId(show)));
    return card;
  }
  function flushLibrary() {
    var data = state[state.tab];
    if (!data || !data.backgroundReady || state.detail || player.active || playPending || sortTrigger || keyboard.active || !el('login-view').hidden) return;
    var key = document.activeElement && document.activeElement.getAttribute('data-focus');
    renderShows(null, true);
    if (key) focusKey(key);
  }
  function renderShows(restoreFocus, keepFocus) {
    var tab = state.tab;
    var data = state[tab];
    data.backgroundReady = false;
    if (tab === 'my') data.shows = sortShows(store.favorites('show'), tab);
    var query = data.query.trim();
    var shows = sortShows(data.shows || [], tab).filter(function (show) {
      return window.SoapCatalog.matches(show, query) && (tab !== 'movies' || !moviesFilter || store.isFavorite('movie', show.id));
    });
    var continued = !query && (tab === 'my' || tab === 'movies') ? store.continueList(tab === 'movies' ? 'movie' : 'show').map(function (entry) {
      // Snapshots date from playback; a loaded catalog has the current counts.
      if (tab === 'my' && freshShows[entry.card.sid]) entry.card = freshShows[entry.card.sid];
      return entry;
    }).filter(function (entry) {
      return entry.record.status !== 'watched' || store.adjustedUnwatched(entry.card) > 0;
    }).slice(0, 4) : [];
    var info = pageInfo(shows.length, data.page, continued.length ? 14 : PAGE_SIZE);
    data.page = info.page;
    data.pageInfo = info;
    el('section-summary').textContent = query ? 'Найдено: ' + shows.length : (tab === 'movies' ? 'Фильмов: ' : 'Сериалов: ') + shows.length;
    clear(el('content'));
    var fragment = document.createDocumentFragment();
    if (continued.length && data.page === 0) {
      var row = node('div', 'continue-section');
      row.appendChild(node('h2', '', 'Продолжить'));
      var cards = node('div', 'continue-row');
      continued.forEach(function (entry) { cards.appendChild(cardButton(entry.card, tab === 'movies', entry)); });
      row.appendChild(cards);
      fragment.appendChild(row);
    }
    var grid = node('div', 'show-grid');
    shows.slice(info.start, info.start + info.size).forEach(function (show, index) {
      var card = cardButton(show, tab === 'movies');
      card.setAttribute('data-grid-index', index);
      grid.appendChild(card);
    });
    fragment.appendChild(grid);
    if (!shows.length) {
      var message = node('div', 'empty-state');
      message.appendChild(node('h2', '', query ? 'Ничего не найдено' : 'Здесь пока пусто'));
      message.appendChild(node('p', '', tab === 'my' ? 'Выберите любимые сериалы в каталоге.' : 'Попробуйте другое название или фильтр.'));
      if (tab === 'my') message.appendChild(button('К сериалам', 'primary-button', function () { openLibrary('all'); }, 'open-all'));
      fragment.appendChild(message);
    }
    el('content').appendChild(fragment);
    pagination(info, function (page) { data.page = page; renderShows(); });
    if (!keepFocus) focusKey(restoreFocus);
  }

  function nextEpisode(detail, afterCompleted) {
    var progress = store.nextEpisodeLabel(showId(detail.show));
    var latest = store.continueList('show').filter(function (entry) { return String(entry.media.sid) === String(showId(detail.show)); })[0];
    if (afterCompleted && latest && latest.record.status === 'watched') {
      var following = detail.episodes.filter(function (episode) { return Number(episode.season) === Number(latest.media.season) && Number(episode.episode) === Number(latest.media.episode) + 1 && !watched(episode) && russianFile(episode.files); })[0];
      if (following) return following;
    }
    var resumed = progress && detail.episodes.filter(function (episode) { return Number(episode.season) === progress.season && Number(episode.episode) === progress.episode && russianFile(episode.files); })[0];
    return resumed || detail.episodes.filter(function (episode) { return !watched(episode) && russianFile(episode.files); })[0] || detail.episodes[0];
  }
  function openShow(show, fromContinue) {
    var generation = ++requestGeneration;
    if (freshShows[show.sid]) show = freshShows[show.sid];
    var remembered = showPositions[String(showId(show))];
    state.detail = { kind: 'show', show: show, episodes: null, seasons: [], season: null, page: 0, afterCompleted: !!fromContinue };
    libraryHeading();
    el('section-summary').textContent = 'Получаем список серий';
    loading();
    api.getEpisodes(showId(show)).then(function (response) {
      if (generation !== requestGeneration) return;
      var detail = state.detail;
      detail.episodes = api.normalizeEpisodes(response).slice().sort(function (a, b) { return Number(a.season) - Number(b.season) || Number(a.episode) - Number(b.episode); });
      store.syncShowEpisodes(showId(show), detail.episodes);
      detail.episodes.forEach(function (episode) {
        var season = String(episode.season);
        if (detail.seasons.indexOf(season) === -1) detail.seasons.push(season);
      });
      detail.next = nextEpisode(detail, fromContinue);
      detail.season = detail.next ? String(detail.next.season) : detail.seasons[0];
      var inSeason = detail.episodes.filter(function (episode) { return String(episode.season) === detail.season; });
      detail.page = Math.max(0, Math.floor(inSeason.indexOf(detail.next) / EPISODE_PAGE_SIZE));
      if (remembered && !fromContinue && detail.seasons.indexOf(remembered.season) !== -1) {
        detail.season = remembered.season;
        detail.page = remembered.page;
      }
      renderEpisodes(fromContinue && detail.next ? episodeFocus(detail.next) : 'show-play');
    }).catch(function (error) {
      if (generation !== requestGeneration || handleAuth(error)) return;
      el('section-summary').textContent = '';
      empty('Не получилось загрузить серии', errorText(error), function () { openShow(show); });
      focusKey('retry');
    });
  }

  function openMovie(movie) {
    requestGeneration++;
    movie = (state.movies.shows || []).filter(function (item) { return String(item.id) === String(movie.id); })[0] || movie;
    state.detail = { kind: 'movie', show: movie, movie: movie };
    libraryHeading();
    renderMovie();
  }

  function artwork(show, className, covers) {
    var item = node('div', className);
    covers = covers || show.covers;
    // A single detail poster can afford the sharp cover; grids stay on small ones.
    item.appendChild(poster(covers && (covers.big || covers.small), title(show).slice(0, 1)));
    var ratings = ratingBadges(show);
    if (ratings) item.appendChild(ratings);
    return item;
  }
  function renderMovie(restoreFocus) {
    var movie = state.detail.show;
    var media = movieMedia(movie);
    var saved = store.get(media);
    clear(el('content'));
    clear(el('pagination'));
    el('section-summary').textContent = (movie.year || '') + (store.effectiveWatched(media, movie.watched) ? ' · Просмотрено' : '');
    var layout = node('div', 'movie-layout');
    layout.appendChild(artwork(movie, 'movie-artwork'));
    var info = node('div', 'movie-info');
    var actions = node('div', 'movie-actions');
    actions.appendChild(button(store.resumeMs(media, 0) ? 'Продолжить' : 'Смотреть', 'primary-button play-button', function () { playMovie(false); }, 'movie-play'));
    if (saved && saved.positionMs > 0) actions.appendChild(button('Сначала', '', function () { playMovie(true); }, 'movie-restart'));
    actions.appendChild(button(favoriteLabel('movie', movie), '', function () { toggleFavorite('movie', movie); }, 'detail-favorite'));
    actions.appendChild(button(store.effectiveWatched(media, movie.watched) ? 'Снять отметку' : 'Отметить просмотренным', '', function () {
      store.setWatched(media, !store.effectiveWatched(media, movie.watched), movie);
      renderMovie('movie-watched');
    }, 'movie-watched'));
    info.appendChild(actions);
    info.appendChild(node('p', 'movie-description', plainDescription(movie.description)));
    layout.appendChild(info);
    el('content').appendChild(layout);
    focusKey(restoreFocus || 'movie-play');
  }

  function playMovie(fromStart) {
    if (playPending || player.active || !state.detail || state.detail.kind !== 'movie') return;
    var detail = state.detail;
    var generation = ++playbackGeneration;
    playPending = true;
    lastEpisodeFocus = 'movie-play';
    playingEpisode = null;
    el('busy-overlay').hidden = false;
    api.getMoviePlayback(detail.show.id).then(function (playback) {
      if (generation !== playbackGeneration || !playPending) return;
      playPending = false;
      el('busy-overlay').hidden = true;
      beginMedia(movieMedia(detail.show), detail.show, playback, fromStart);
      player.start(playback, title(detail.show));
    }).catch(function (error) {
      if (generation !== playbackGeneration) return;
      playPending = false;
      el('busy-overlay').hidden = true;
      if (handleAuth(error)) return;
      toast(error && (error.code === 'NO_RUSSIAN_AUDIO' || error.code === 'NO_COMPATIBLE_VIDEO' || error.code === 'INVALID_RESPONSE') ? error.message : errorText(error));
      focusKey('movie-play');
    });
  }

  function renderEpisodes(restoreFocus) {
    var detail = state.detail;
    updateDetailActions();
    clear(el('content'));
    clear(el('pagination'));
    if (!detail.episodes.length) {
      empty('Серий пока нет', 'Вернитесь в каталог и выберите другой сериал.');
      return;
    }
    detail.next = nextEpisode(detail, detail.afterCompleted);
    var allInSeason = selectedEpisodes('season');
    el('section-summary').textContent = 'Сезон ' + detail.season + ' · Серий: ' + allInSeason.length;
    var fragment = document.createDocumentFragment();
    var layout = node('div', 'show-layout');
    var aside = node('div', 'show-artwork');
    aside.appendChild(artwork(detail.show, 'detail-poster', allInSeason[0] && allInSeason[0].covers));
    aside.appendChild(node('p', 'detail-meta', detail.show.year || ''));
    layout.appendChild(aside);
    var info = node('div', 'show-info');
    var actions = node('div', 'show-actions');
    var next = detail.next;
    var label = next ? (store.resumeMs(episodeMedia(next), 0) ? 'Продолжить ' : 'Смотреть ') + 'S' + next.season + 'E' + next.episode : 'Смотреть';
    var play = button(label, 'primary-button play-button', function () {
      if (!next) return;
      detail.season = String(next.season);
      var episodes = selectedEpisodes('season');
      detail.page = Math.floor(episodes.indexOf(next) / EPISODE_PAGE_SIZE);
      renderEpisodes(episodeFocus(next));
      playEpisode(next, russianFile(next.files));
    }, 'show-play');
    actions.appendChild(play);
    actions.appendChild(button(favoriteLabel('show', detail.show), '', function () { toggleFavorite('show', detail.show); }, 'detail-favorite'));
    actions.appendChild(button('Ещё', '', openMore, 'show-more'));
    info.appendChild(actions);
    var seasons = node('div', 'season-list');
    detail.seasons.forEach(function (season) {
      var item = button(season, 'season-button' + (season === detail.season ? ' active' : ''), function () {
        detail.season = season;
        detail.page = 0;
        renderEpisodes('season-' + season);
      }, 'season-' + season);
      item.setAttribute('aria-label', 'Сезон ' + season);
      item.setAttribute('aria-pressed', season === detail.season ? 'true' : 'false');
      seasons.appendChild(item);
    });
    info.appendChild(seasons);
    var page = pageInfo(allInSeason.length, detail.page, EPISODE_PAGE_SIZE, EPISODE_PAGE_SIZE);
    detail.page = page.page;
    detail.pageInfo = page;
    var list = node('div', 'episode-list');
    allInSeason.slice(page.start, page.start + page.size).forEach(function (episode, index) {
      var file = russianFile(episode.files);
      var media = episodeMedia(episode);
      var item = button('', 'episode-button', function () { playEpisode(episode, file); }, episodeFocus(episode));
      item.setAttribute('data-context', 'episode');
      item.setAttribute('data-grid-index', index);
      item.contextAction = function () {
        openContext(item, [
          {label: 'Смотреть сначала', action: function () { playEpisode(episode, file, true); }},
          {label: watched(episode) ? 'Снять отметку' : 'Отметить просмотренной', action: function () {
            store.setWatched(media, !watched(episode), detail.show);
            renderEpisodes(episodeFocus(episode));
          }}
        ]);
      };
      item.appendChild(node('span', 'episode-number', episode.episode));
      var copy = node('span', 'episode-copy');
      copy.appendChild(node('span', 'episode-title', episodeTitle(episode)));
      var metadata = node('span', 'episode-details');
      metadata.appendChild(watched(episode) ? node('span', 'episode-status status-watched') : file ? node('span', 'episode-status status-playable') : node('span', 'episode-status', 'нет озвучки'));
      if (file) metadata.appendChild(node('span', 'episode-meta', qualityLabel(file)));
      copy.appendChild(metadata);
      item.appendChild(copy);
      appendProgress(item, store.get(media), 'episode-progress');
      list.appendChild(item);
    });
    info.appendChild(list);
    layout.appendChild(info);
    fragment.appendChild(layout);
    el('content').appendChild(fragment);
    pagination(page, function (page) { detail.page = page; renderEpisodes(); });
    // Scroll the active season into view without moving focus away from the action.
    var activeSeason = seasons.querySelector('.active');
    if (activeSeason) activeSeason.scrollIntoView({block: 'nearest', inline: 'nearest'});
    focusKey(restoreFocus, play);
  }
  function backToLibrary() { openLibrary(state.tab, false, lastShowFocus); }
  function openMore() {
    el('more-description').textContent = plainDescription(state.detail.show.description);
    updateDetailActions();
    el('more-panel').hidden = false;
    focus(el('mark-season'));
  }
  function closeMore(restore) {
    if (el('more-panel').hidden) return;
    el('more-panel').hidden = true;
    if (restore) focusKey('show-more');
  }
  function markWatched(scope) {
    var detail = state.detail;
    if (!detail || detail.kind !== 'show' || !detail.episodes) return;
    var episodes = selectedEpisodes(scope);
    store.setEpisodesWatched(showId(detail.show), episodes, !episodes.every(watched), detail.show);
    renderEpisodes();
    updateDetailActions();
    focus(el('mark-' + scope));
  }

  function playEpisode(episode, file, fromStart) {
    if (!file || playPending || player.active) return;
    var detail = state.detail;
    var generation = ++playbackGeneration;
    playPending = true;
    lastEpisodeFocus = episodeFocus(episode);
    el('busy-overlay').hidden = false;
    api.getPlayback(showId(detail.show), file).then(function (playback) {
      if (generation !== playbackGeneration || !playPending) return;
      playPending = false;
      el('busy-overlay').hidden = true;
      playingEpisode = { episode: episode, detail: detail, generation: generation };
      beginMedia(episodeMedia(episode, detail), detail.show, playback, fromStart);
      player.start(playback, title(detail.show) + ' · ' + episode.season + ' сезон, ' + episode.episode + ' серия');
    }).catch(function (error) {
      if (generation !== playbackGeneration) return;
      playPending = false;
      el('busy-overlay').hidden = true;
      if (handleAuth(error)) return;
      toast(errorText(error));
      focusKey(lastEpisodeFocus);
    });
  }

  function playNextEpisode(completed) {
    if (!completed || document.hidden || completed.generation !== playbackGeneration || state.detail !== completed.detail) return;
    var detail = completed.detail;
    var episodes = detail.episodes.filter(function (episode) { return String(episode.season) === String(completed.episode.season); });
    var index = -1;
    for (var i = 0; i < episodes.length; i++) {
      if (String(episodes[i].episode) === String(completed.episode.episode)) { index = i; break; }
    }
    if (index < 0 || index === episodes.length - 1) return;
    var next = episodes[index + 1];
    if (Number(next.episode) !== Number(completed.episode.episode) + 1) {
      toast('Следующая серия пока недоступна.');
      return;
    }
    var file = russianFile(next.files);
    if (!file) {
      toast('У следующей серии пока нет русской озвучки.');
      return;
    }
    detail.season = String(next.season);
    detail.page = Math.floor((index + 1) / EPISODE_PAGE_SIZE);
    renderEpisodes(episodeFocus(next));
    playEpisode(next, file);
  }

  function back() {
    if (playPending) {
      playbackGeneration++;
      playPending = false;
      el('busy-overlay').hidden = true;
      focusKey(lastEpisodeFocus);
      return;
    }
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
      focus(el('login-view').hidden ? el('nav-' + state.tab) : el('login-submit'));
      return;
    }
    if (!el('more-panel').hidden) { closeMore(true); return; }
    if (state.detail && el('login-view').hidden) { backToLibrary(); return; }
    if (el('login-view').hidden && !el('navigation').contains(document.activeElement) && !el('account').contains(document.activeElement)) {
      focus(el('nav-' + state.tab));
      lastBack = 0;
      return;
    }
    if (Date.now() - lastBack < 2000 && window.tizen && window.tizen.application) {
      try { window.tizen.application.getCurrentApplication().exit(); } catch (ignored) { toast('Закройте приложение кнопкой Home.'); }
    } else {
      lastBack = Date.now();
      toast(window.tizen ? 'Нажмите Назад ещё раз, чтобы закрыть приложение' : 'Вы в главном меню');
    }
  }

  function openContext(trigger, options) {
    closeSort(false);
    sortTrigger = trigger;
    var menu = el('sort-menu');
    clear(menu);
    options.forEach(function (option, index) {
      menu.appendChild(button(option.label, 'sort-option', function () {
        closeSort(false);
        option.action();
        focusKey(trigger.getAttribute('data-focus'));
      }, 'context-' + index));
    });
    menu.hidden = false;
    focus(menu.firstChild);
  }
  function cancelOK() {
    if (okHold) clearTimeout(okHold.timer);
    okHold = null;
  }
  function longOK(event) {
    var item = document.activeElement;
    if (!item || !item.getAttribute('data-context') || sortTrigger || player.active || playPending) return false;
    event.preventDefault();
    if (okHold || event.repeat) return true;
    var hold = {item: item, opened: false};
    okHold = hold;
    hold.timer = setTimeout(function () {
      if (okHold !== hold || document.activeElement !== item) return;
      hold.opened = true;
      item.contextAction();
    }, 600);
    return true;
  }
  function cancelConfirmation() {
    if (!confirmAction) return;
    confirmAction.item.textContent = confirmAction.label;
    confirmAction = null;
  }
  function confirm(item, action) {
    if (confirmAction && confirmAction.item === item) {
      cancelConfirmation();
      action();
      return;
    }
    cancelConfirmation();
    confirmAction = {item: item, label: item.textContent};
    item.textContent = 'Нажмите ещё раз';
  }
  function invalidateCatalogs() {
    ['my', 'all', 'movies'].forEach(function (tab) { state[tab].shows = null; state[tab].request = 0; state[tab].backgroundReady = false; });
  }
  function renderSettings() {
    clear(el('content'));
    clear(el('pagination'));
    el('section-summary').textContent = 'Soap4Samsung · v' + String(config.version || appVersion || '');
    var panel = node('div', 'settings-panel');
    panel.appendChild(button('Обновить данные', '', function () {
      invalidateCatalogs();
      showPositions = {};
      toast('Данные обновятся при открытии раздела.');
    }, 'settings-refresh'));
    var reset = button('Сбросить локальные данные', '', function () { confirm(reset, function () {
      store.reset();
      invalidateCatalogs();
      showPositions = {};
      toast('Локальные данные сброшены.');
    }); }, 'settings-reset');
    reset.setAttribute('data-confirm', 'true');
    panel.appendChild(reset);
    var logout = button('Выйти', '', function () { confirm(logout, function () {
      loginDestination = null;
      api.setToken('');
      storageSet(TOKEN_KEY, null);
      state.my.shows = state.all.shows = state.movies.shows = null;
      freshShows = {};
      state.detail = null;
      showLogin();
    }); }, 'settings-logout');
    logout.setAttribute('data-confirm', 'true');
    panel.appendChild(logout);
    el('content').appendChild(panel);
    focusKey('settings-refresh');
  }
  function gridPage(code) {
    if (code !== 38 && code !== 40) return false;
    var current = document.activeElement;
    var value = current && current.getAttribute('data-grid-index');
    if (value === null || value === undefined) return false;
    var grid = current.parentNode;
    var items = grid.querySelectorAll('button');
    var columns = state.detail ? 4 : 7;
    var index = Number(value);
    var row = Math.floor(index / columns);
    var lastRow = Math.floor((items.length - 1) / columns);
    if ((code === 38 && row > 0) || (code === 40 && row < lastRow)) return false;
    var data = state.detail || state[state.tab];
    var info = data.pageInfo;
    if (!info) return false;
    var direction = code === 38 ? -1 : 1;
    if (info.page + direction < 0) {
      focus(state.detail ? el('content').querySelector('.season-button.active') : el('nav-' + state.tab));
      return true;
    }
    if (info.page + direction >= info.pages) return true;
    var now = Date.now();
    if (now - pageChangedAt < 250) return true;
    pageChangedAt = now;
    data.page += direction;
    if (state.detail) renderEpisodes(); else renderShows();
    var nextGrid = el('content').querySelector(state.detail ? '.episode-list' : '.show-grid');
    var nextItems = nextGrid.querySelectorAll('button');
    var target = index % columns;
    if (direction < 0) target += Math.floor((nextItems.length - 1) / columns) * columns;
    focus(nextItems[Math.min(target, nextItems.length - 1)]);
    return true;
  }
  function moveFocus(code) {
    if (gridPage(code)) return;
    var current = document.activeElement;
    var selector = !el('more-panel').hidden ? '#more-panel button:not(:disabled)' : '#app-shell button:not(:disabled), #app-shell input:not(:disabled)';
    var candidates = [];
    var origin = null;
    // One geometry read per candidate, including the currently focused item.
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (item) {
      if (item.classList.contains('page-indicator')) return;
      var rect = item.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      candidates.push({item: item, rect: rect});
      if (item === current) origin = rect;
    });
    if (!origin) { if (candidates.length) focus(candidates[0].item); return; }
    var ox = origin.left + origin.width / 2;
    var oy = origin.top + origin.height / 2;
    var horizontal = code === 37 || code === 39;
    var best = null;
    var bestScore = Infinity;
    candidates.forEach(function (entry) {
      if (entry.item === current) return;
      var rect = entry.rect;
      var dx = rect.left + rect.width / 2 - ox;
      var dy = rect.top + rect.height / 2 - oy;
      if ((code === 37 && dx >= -1) || (code === 39 && dx <= 1) || (code === 38 && dy >= -1) || (code === 40 && dy <= 1)) return;
      var primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      var secondary = horizontal ? Math.abs(dy) : Math.abs(dx);
      var overlap = horizontal ? rect.bottom > origin.top && rect.top < origin.bottom : rect.right > origin.left && rect.left < origin.right;
      var score = primary + secondary * 3 + (overlap ? 0 : 2000);
      if (score < bestScore) { bestScore = score; best = entry.item; }
    });
    if (best) focus(best);
  }

  function keydown(event) {
    var code = event.keyCode || event.which;
    if (code === 27 || code === 10009) {
      if (backDown) { event.preventDefault(); return; }
      backDown = true;
    }
    if (keyboard.handleKey(event)) { flushLibrary(); return; }
    if (code === 13 && (okHold || sortEnterDown)) { event.preventDefault(); return; }
    if (code === 13 && document.activeElement && document.activeElement.getAttribute('data-confirm')) {
      event.preventDefault();
      if (!sortEnterDown && !event.repeat) { sortEnterDown = true; document.activeElement.click(); }
      return;
    }
    if (code === 13 && longOK(event)) return;
    if ((code === 13 || code === 32) && (sortTrigger || (document.activeElement && document.activeElement.classList.contains('sort-button')))) {
      event.preventDefault();
      if (!sortEnterDown && !event.repeat) {
        sortEnterDown = true;
        if (sortTrigger) document.activeElement.click();
        else openSort();
      }
      return;
    }
    if (sortKey(event, code)) return;
    if (code === 13 && document.activeElement === el('search') && !state.detail && !playPending && !player.active) {
      event.preventDefault();
      if (!event.repeat && !keyboard.enterDown) keyboard.open(state[state.tab].query, el('search'), true);
      return;
    }
    if (player.handleKey(code, event)) { event.preventDefault(); return; }
    if (code === 10009 || code === 27) { event.preventDefault(); back(); return; }
    if (playPending) { event.preventDefault(); return; }
    var isInput = document.activeElement && document.activeElement.tagName === 'INPUT';
    if ((code === 65376 || code === 65385) && isInput) { event.preventDefault(); back(); return; }
    if (code >= 37 && code <= 40) {
      if (isInput && (code === 37 || code === 39)) return;
      event.preventDefault();
      moveFocus(code);
    }
    // Browser and Tizen both dispatch native button clicks for Enter.
  }

  function init() {
    var version = String(config.version || '');
    if (!version) {
      try { if (window.tizen && window.tizen.application) version = window.tizen.application.getCurrentApplication().appInfo.version; } catch (ignored) { /* Browser preview gets its version from the local config. */ }
    }
    appVersion = version;
    if (version) {
      el('login-version').textContent = 'v' + version;
      el('login-version').hidden = false;
    }
    if (!window.SoapApi || !window.SoapPlayer || !window.SoapKeyboard || !window.SoapCatalog || !window.SoapStore) {
      el('login-view').hidden = false;
      el('login-error').textContent = 'Приложение загружено не полностью. Переустановите пакет.';
      return;
    }
    var token = storageGet(TOKEN_KEY) || '';
    var savedMySort = storageGet(MY_SORT_KEY);
    var savedMoviesSort = storageGet(MOVIES_SORT_KEY);
    var savedAllSort = storageGet(ALL_SORT_KEY);
    mySort = Object.prototype.hasOwnProperty.call(SORT_LABELS, savedMySort) ? savedMySort : 'unwatched';
    moviesSort = ['title', 'year', 'imdb', 'kinopoisk', 'soap'].indexOf(savedMoviesSort) !== -1 ? savedMoviesSort : 'year';
    allSort = ['title', 'year', 'imdb', 'kinopoisk', 'soap'].indexOf(savedAllSort) !== -1 ? savedAllSort : 'title';
    var localStorageAccess;
    try { localStorageAccess = window.localStorage; } catch (ignored) { /* The store reports unavailable storage on its first write. */ }
    store = new window.SoapStore({storage: localStorageAccess, onWriteError: function () {
      if (writeErrorShown) return;
      writeErrorShown = true;
      toast('Не удалось сохранить локальные данные на телевизоре.');
    }});
    api = new window.SoapApi({ baseUrl: config.apiBase, siteBaseUrl: config.siteBase, token: token });
    player = new window.SoapPlayer({
      onStart: function () {
        el('app-shell').hidden = true;
        document.body.classList.add('playing');
        document.documentElement.classList.add('playing');
      },
      onProgress: saveProgress,
      onStop: function (message, reason, snapshot) {
        saveProgress(snapshot);
        currentMedia = null;
        var completed = playingEpisode;
        if (reason === 'ended' && completed) completed.detail.afterCompleted = true;
        playingEpisode = null;
        document.body.classList.remove('playing');
        document.documentElement.classList.remove('playing');
        el('app-shell').hidden = false;
        if (state.detail && state.detail.kind === 'show' && state.detail.episodes) renderEpisodes(lastEpisodeFocus);
        else if (state.detail && state.detail.kind === 'movie') renderMovie(lastEpisodeFocus);
        focusKey(lastEpisodeFocus);
        toast(message);
        if (reason === 'ended') playNextEpisode(completed);
      },
      onNotice: toast
    });
    el('login-form').addEventListener('submit', login);
    el('nav-my').addEventListener('click', function () { openLibrary('my'); });
    el('nav-all').addEventListener('click', function () { openLibrary('all'); });
    el('nav-movies').addEventListener('click', function () { openLibrary('movies'); });
    el('mark-show').addEventListener('click', function () { markWatched('show'); });
    el('mark-season').addEventListener('click', function () { markWatched('season'); });
    ['my', 'all', 'movies'].forEach(function (tab) { el('sort-' + tab).addEventListener('click', openSort); });
    el('nav-settings').addEventListener('click', function () { openLibrary('settings'); });
    el('movies-filter').addEventListener('click', function () {
      moviesFilter = !moviesFilter;
      storageSet('soap4samsung.movies-filter', moviesFilter ? 'favorites' : 'all');
      state.movies.page = 0;
      libraryHeading();
      renderShows(null, true);
      focus(el('movies-filter'));
    });
    keyboard = new window.SoapKeyboard({ onApply: function (query) {
      state[state.tab].query = query;
      state[state.tab].page = 0;
      updateSearchButton();
      if (state[state.tab].shows) renderShows(null, true);
    } });
    el('search').addEventListener('click', function () {
      if (!state.detail && !playPending && !player.active && !keyboard.enterDown) keyboard.open(state[state.tab].query, el('search'), false);
    });
    document.addEventListener('keydown', keydown);
    document.addEventListener('keyup', function (event) {
      keyboard.handleKeyUp(event);
      player.handleKeyUp(event.keyCode || event.which);
      var code = event.keyCode || event.which;
      if (code === 13 && okHold) {
        event.preventDefault();
        var hold = okHold;
        cancelOK();
        if (!hold.opened && document.activeElement === hold.item) hold.item.click();
        flushLibrary();
      }
      if (code === 13 || code === 32) sortEnterDown = false;
      if (code === 27 || code === 10009) backDown = false;
    });
    document.addEventListener('click', function (event) {
      if (sortTrigger && event.target !== sortTrigger && !el('sort-menu').contains(event.target)) closeSort(false);
      flushLibrary();
    });
    document.addEventListener('focusin', function (event) {
      if (confirmAction && event.target !== confirmAction.item) cancelConfirmation();
      if (okHold && !okHold.opened && event.target !== okHold.item) cancelOK();
    });
    window.addEventListener('blur', function () { cancelOK(); cancelConfirmation(); player.resetHold(); keyboard.handleBlur(); sortEnterDown = false; backDown = false; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { cancelOK(); cancelConfirmation(); closeMore(false); keyboard.close(false); closeSort(false); player.resetHold(); }
      // Returning to the series list avoids an AVPlay session left in an invalid state after Home.
      if (document.hidden && (player.active || playPending)) {
        playbackGeneration++;
        playPending = false;
        el('busy-overlay').hidden = true;
        player.stop(true);
      }
    });
    window.addEventListener('pagehide', function () {
      saveProgress(player.snapshot());
      playbackGeneration++;
      playPending = false;
      playingEpisode = null;
      player.stop(false);
      currentMedia = null;
    });
    el('player-view').addEventListener('click', function () { player.setPaused(!player.paused); });
    try {
      if (window.tizen && window.tizen.tvinputdevice) {
        ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'Info'].forEach(function (key) {
          try { window.tizen.tvinputdevice.registerKey(key); } catch (ignored) { /* Some remotes do not expose all keys. */ }
        });
      }
    } catch (ignored) { /* Browser preview uses ordinary keyboard events. */ }
    if (token) openLibrary('my'); else showLogin();
  }

  init();
}());
