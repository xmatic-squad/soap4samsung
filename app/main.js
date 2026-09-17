(function () {
  'use strict';

  var PAGE_SIZE = 12;
  var EPISODE_PAGE_SIZE = 16;
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
  var watchedRevision = 0;
  var watchedShowRevisions = {};
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
    item.focus();
    try { item.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (ignored) { /* Focus still works on older engines. */ }
    // Native scrollIntoView does not account for our fixed footer.
    var rect = item.getBoundingClientRect();
    var footerHeight = el('footer').hidden ? 0 : el('footer').getBoundingClientRect().height;
    var bottom = window.innerHeight - footerHeight - 14;
    if (rect.bottom > bottom) window.scrollBy(0, rect.bottom - bottom);
    else if (rect.top < 14) window.scrollBy(0, rect.top - 14);
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
    return window.SoapCatalog.sort(shows, tab === 'my' ? mySort : tab === 'movies' ? moviesSort : allSort);
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
    badges.forEach(function (rating) {
      var badge = node('span', 'rating-badge rating-' + rating.source);
      badge.appendChild(node('span', 'rating-source', rating.label));
      badge.appendChild(node('span', 'rating-value', rating.text));
      badge.setAttribute('aria-label', (rating.source === 'kinopoisk' ? 'Кинопоиск' : rating.source === 'soap' ? 'Soap4me' : 'IMDb') + ': ' + rating.text + ' из 10');
      group.appendChild(badge);
    });
    return group;
  }
  function updateDetailActions() {
    var detail = state.detail;
    el('detail-actions').hidden = !detail || detail.kind === 'movie';
    if (!detail || detail.kind === 'movie') return;
    var episodes = detail.episodes || [];
    var season = episodes.filter(function (episode) { return String(episode.season) === detail.season; });
    var showWatched = episodes.length > 0 && episodes.every(function (episode) { return Number(episode.watched) > 0; });
    var seasonWatched = season.length > 0 && season.every(function (episode) { return Number(episode.watched) > 0; });
    el('mark-show').disabled = !!detail.marking || !episodes.length || showWatched;
    el('mark-season').disabled = !!detail.marking || !season.length || seasonWatched;
    el('mark-show').textContent = detail.marking === 'show' ? 'Отмечаем сериал…' : showWatched ? 'Весь сериал просмотрен' : 'Отметить сериал просмотренным';
    el('mark-season').textContent = detail.marking === 'season' ? 'Отмечаем сезон…' : seasonWatched ? 'Весь сезон просмотрен' : 'Отметить сезон просмотренным';
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
    if (keyboard) keyboard.close(false, false);
    requestGeneration++;
    playbackGeneration++;
    playPending = false;
    playingEpisode = null;
    el('busy-overlay').hidden = true;
    player.stop(false);
    document.body.classList.remove('playing');
    document.documentElement.classList.remove('playing');
    el('app-shell').hidden = false;
    el('login-view').hidden = false;
    el('library-view').hidden = true;
    el('navigation').hidden = true;
    el('account').hidden = true;
    el('footer').hidden = true;
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
    el('footer').hidden = false;
    ['my', 'all', 'movies'].forEach(function (tab) {
      el('nav-' + tab).classList.toggle('active', state.tab === tab);
      el('nav-' + tab).setAttribute('aria-current', state.tab === tab ? 'page' : 'false');
    });
    el('search-box').hidden = !!state.detail;
    el('library-tools').hidden = !!state.detail;
    el('sort-my').hidden = !!state.detail || state.tab !== 'my';
    el('sort-movies').hidden = !!state.detail || state.tab !== 'movies';
    el('sort-all').hidden = !!state.detail || state.tab !== 'all';
    updateSortButton();
    updateDetailActions();
    el('section-title').textContent = state.detail ? title(state.detail.show) : state.tab === 'my' ? 'Мои сериалы' : state.tab === 'movies' ? 'Фильмы' : 'Каталог';
    updateSearchButton();
  }

  function updateSearchButton() {
    var query = state[state.tab].query;
    el('search').textContent = query || 'Поиск по названию';
    el('search').classList.toggle('has-query', !!query);
    el('search').setAttribute('aria-label', query ? 'Поиск: ' + query + '. Изменить запрос' : 'Поиск по названию');
  }

  function openLibrary(tab, force, restoreFocus) {
    state.tab = tab;
    state.detail = null;
    var generation = ++requestGeneration;
    var revision = watchedRevision;
    var data = state[tab];
    libraryHeading();
    if (!force && data.shows) { renderShows(restoreFocus); return; }
    el('section-summary').textContent = tab === 'movies' ? 'Получаем список фильмов' : 'Получаем список сериалов';
    loading();
    var request = tab === 'my' ? api.getMyShows() : tab === 'movies' ? api.getMovies() : api.getAllShows();
    request.then(function (shows) {
      if (generation !== requestGeneration) return;
      if (tab !== 'movies' && revision !== watchedRevision) { openLibrary(tab, false, restoreFocus); return; }
      data.shows = sortShows(Array.isArray(shows) ? shows : [], tab);
      renderShows(restoreFocus);
    }).catch(function (error) {
      if (generation !== requestGeneration || handleAuth(error)) return;
      el('section-summary').textContent = '';
      empty(tab === 'movies' ? 'Не получилось загрузить фильмы' : 'Не получилось загрузить сериалы', errorText(error), function () { openLibrary(tab, true); });
      focusKey('retry');
    });
  }

  function pagination(total, page, change, pageSize) {
    var container = el('pagination');
    clear(container);
    var pages = Math.ceil(total / (pageSize || PAGE_SIZE));
    if (pages <= 1) return;
    var previous = button('← Предыдущая', '', function () { change(page - 1); }, 'page-previous');
    previous.disabled = page === 0;
    var next = button('Следующая →', '', function () { change(page + 1); }, 'page-next');
    next.disabled = page >= pages - 1;
    container.appendChild(previous);
    container.appendChild(node('span', '', (page + 1) + ' / ' + pages));
    container.appendChild(next);
  }

  function renderShows(restoreFocus, keepFocus) {
    var data = state[state.tab];
    var query = data.query.trim();
    var shows = (data.shows || []).filter(function (show) {
      return window.SoapCatalog.matches(show, query);
    });
    data.page = Math.min(data.page, Math.max(0, Math.ceil(shows.length / PAGE_SIZE) - 1));
    el('section-summary').textContent = query ? 'Найдено: ' + shows.length : (state.tab === 'movies' ? 'Фильмов: ' : 'Сериалов: ') + shows.length;
    if (!shows.length) {
      empty(query ? 'Ничего не найдено' : 'Здесь пока пусто', query ? 'Попробуйте другое название — на русском или английском.' : state.tab === 'my' ? 'Добавьте сериалы в «Мои» на сайте Soap4me и нажмите «Обновить».' : state.tab === 'movies' ? 'Сервис не вернул фильмы.' : 'Сервис не вернул сериалы.');
      if (!keepFocus) focus(el('search'));
      return;
    }
    clear(el('content'));
    var grid = node('div', 'show-grid');
    shows.slice(data.page * PAGE_SIZE, (data.page + 1) * PAGE_SIZE).forEach(function (show) {
      var isMovie = state.tab === 'movies';
      var key = isMovie ? 'movie-' + show.id : 'show-' + showId(show);
      var card = button('', 'show-card', function () { lastShowFocus = key; if (isMovie) openMovie(show); else openShow(show); }, key);
      card.setAttribute('aria-label', title(show));
      var cover = show.covers && (show.covers.small || show.covers.big);
      card.appendChild(poster(cover, title(show).slice(0, 1)));
      var ratings = ratingBadges(show);
      if (ratings) card.appendChild(ratings);
      var copy = node('span', 'show-copy');
      copy.appendChild(node('span', 'show-title', title(show)));
      var meta = [];
      if (show.year) meta.push(show.year);
      if (isMovie) meta.push(Number(show.watched) > 0 ? 'Просмотрено' : 'Не просмотрено');
      else if (state.tab === 'my' && Number(show.unwatched) > 0) meta.push('Не просмотрено: ' + show.unwatched);
      else if (show.title && show.title !== title(show)) meta.push(show.title);
      copy.appendChild(node('span', 'show-meta', meta.join(' · ')));
      card.appendChild(copy);
      grid.appendChild(card);
    });
    el('content').appendChild(grid);
    pagination(shows.length, data.page, function (page) { data.page = page; renderShows(); });
    if (!keepFocus) focusKey(restoreFocus);
  }

  function openShow(show) {
    var generation = ++requestGeneration;
    var revision = watchedShowRevisions[String(showId(show))] || 0;
    state.detail = { kind: 'show', show: show, episodes: null, seasons: [], season: null, page: 0, marking: null };
    libraryHeading();
    el('section-summary').textContent = 'Получаем список серий';
    loading();
    api.getEpisodes(showId(show)).then(function (response) {
      if (generation !== requestGeneration) return;
      if (revision !== (watchedShowRevisions[String(showId(show))] || 0)) { openShow(show); return; }
      var detail = state.detail;
      detail.episodes = api.normalizeEpisodes(response).slice().sort(function (a, b) { return Number(a.season) - Number(b.season) || Number(a.episode) - Number(b.episode); });
      detail.episodes.forEach(function (episode) {
        var season = String(episode.season);
        if (detail.seasons.indexOf(season) === -1) detail.seasons.push(season);
      });
      detail.season = detail.seasons[0] || null;
      // Start in the first season with an available, not-yet-watched Russian episode.
      for (var i = 0; i < detail.episodes.length; i++) {
        if (!Number(detail.episodes[i].watched) && russianFile(detail.episodes[i].files)) { detail.season = String(detail.episodes[i].season); break; }
      }
      renderEpisodes();
    }).catch(function (error) {
      if (generation !== requestGeneration || handleAuth(error)) return;
      el('section-summary').textContent = '';
      empty('Не получилось загрузить серии', errorText(error), function () { openShow(show); });
      focusKey('retry');
    });
  }

  function openMovie(movie) {
    requestGeneration++;
    state.detail = { kind: 'movie', show: movie, movie: movie };
    libraryHeading();
    renderMovie();
  }

  function renderMovie() {
    var detail = state.detail;
    var movie = detail.movie;
    var source = detail.show;
    clear(el('content'));
    clear(el('pagination'));
    updateDetailActions();
    var metadata = [];
    if (movie.year || source.year) metadata.push(movie.year || source.year);
    if (Number(movie.runtime || source.runtime)) metadata.push(Number(movie.runtime || source.runtime) + ' мин');
    metadata.push(Number(movie.watched !== undefined ? movie.watched : source.watched) > 0 ? 'Просмотрено' : 'Не просмотрено');
    el('section-summary').textContent = metadata.join(' · ');
    var layout = node('div', 'movie-layout');
    var cover = movie.covers || source.covers || {};
    var artwork = node('div', 'movie-artwork');
    artwork.appendChild(poster(cover.big || cover.small, title(source).slice(0, 1)));
    var ratings = ratingBadges(movie);
    if (ratings) artwork.appendChild(ratings);
    layout.appendChild(artwork);
    var info = node('div', 'movie-info');
    var description = plainDescription(movie.description || source.description);
    if (description) info.appendChild(node('p', 'movie-description', description));
    info.appendChild(node('p', 'movie-format', 'Русская озвучка'));
    var actions = node('div', 'movie-actions');
    var play = button('▶ Смотреть', 'primary-button', playMovie, 'movie-play');
    actions.appendChild(play);
    actions.appendChild(button('← К фильмам', 'back-button', backToLibrary, 'detail-back'));
    info.appendChild(actions);
    layout.appendChild(info);
    el('content').appendChild(layout);
    focusKey('movie-play');
  }

  function playMovie() {
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
      el('section-summary').textContent = '';
      empty('Серий пока нет', 'Вернитесь в каталог и выберите другой сериал.');
      el('content').appendChild(button('← К сериалам', 'back-button', backToLibrary, 'detail-back'));
      focusKey('detail-back');
      return;
    }
    var allInSeason = detail.episodes.filter(function (episode) { return String(episode.season) === detail.season; });
    var available = allInSeason.filter(function (episode) { return !!russianFile(episode.files); }).length;
    el('section-summary').textContent = 'Сезон ' + detail.season + ' · Серий с русской озвучкой: ' + available + ' из ' + allInSeason.length;
    var description = plainDescription(detail.show.description);
    if (description) el('content').appendChild(node('p', 'detail-description', description));
    var seasons = node('div', 'season-list');
    seasons.appendChild(button('← К сериалам', 'back-button', backToLibrary, 'detail-back'));
    detail.seasons.forEach(function (season) {
      var item = button('', 'season-button' + (season === detail.season ? ' active' : ''), function () {
        detail.season = season;
        detail.page = 0;
        renderEpisodes('season-' + season);
      }, 'season-' + season);
      var fallback = node('span', 'season-fallback', season);
      item.appendChild(fallback);
      var seasonEpisode = detail.episodes.filter(function (episode) { return String(episode.season) === season; })[0];
      var cover = seasonEpisode && seasonEpisode.covers && (seasonEpisode.covers.small || seasonEpisode.covers.big);
      if (typeof cover === 'string' && /^https?:\/\//i.test(cover)) {
        var image = document.createElement('img');
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.onload = function () { fallback.hidden = true; };
        image.onerror = function () { image.hidden = true; };
        image.src = cover;
        item.appendChild(image);
      }
      item.appendChild(node('span', 'season-label', 'Сезон ' + season));
      item.setAttribute('aria-label', 'Сезон ' + season);
      item.setAttribute('aria-pressed', season === detail.season ? 'true' : 'false');
      seasons.appendChild(item);
    });
    el('content').appendChild(seasons);
    detail.page = Math.min(detail.page, Math.max(0, Math.ceil(allInSeason.length / EPISODE_PAGE_SIZE) - 1));
    var list = node('div', 'episode-list');
    allInSeason.slice(detail.page * EPISODE_PAGE_SIZE, (detail.page + 1) * EPISODE_PAGE_SIZE).forEach(function (episode) {
      var file = russianFile(episode.files);
      var item = button('', 'episode-button', function () { playEpisode(episode, file); }, episodeFocus(episode));
      item.disabled = !file;
      item.appendChild(node('span', 'episode-number', ('0' + episode.episode).slice(-2)));
      var copy = node('span', 'episode-copy');
      copy.appendChild(node('span', 'episode-title', episodeTitle(episode)));
      var metadata = node('span', 'episode-details');
      var watched = Number(episode.watched) > 0;
      metadata.appendChild(node('span', 'episode-status ' + (watched ? 'watched' : 'unwatched'), watched ? 'Просмотрено' : 'Не просмотрено'));
      metadata.appendChild(node('span', 'episode-meta', file ? qualityLabel(file) : 'Нет русской озвучки'));
      copy.appendChild(metadata);
      item.appendChild(copy);
      if (file) item.appendChild(node('span', 'play-symbol', '▶'));
      list.appendChild(item);
    });
    el('content').appendChild(list);
    pagination(allInSeason.length, detail.page, function (page) { detail.page = page; renderEpisodes(); }, EPISODE_PAGE_SIZE);
    focusKey(restoreFocus, list.querySelector('button:not(:disabled)') || seasons.querySelector('.season-button.active'));
  }

  function backToLibrary() { openLibrary(state.tab, false, lastShowFocus); }

  function flushDetailUpdates() {
    var detail = state.detail;
    if (!detail || detail.kind === 'movie' || !detail.needsRender || player.active || playPending || !el('login-view').hidden) return;
    detail.needsRender = false;
    renderEpisodes(lastEpisodeFocus);
    toast(detail.markNotice);
    detail.markNotice = null;
  }

  function markWatched(scope) {
    var detail = state.detail;
    if (!detail || detail.kind === 'movie' || detail.marking || !detail.episodes || !detail.episodes.length) return;
    var generation = requestGeneration;
    var token = api.getToken();
    var selectedSeason = detail.season;
    var focusAfter = 'mark-' + scope;
    detail.marking = scope;
    updateDetailActions();
    var operation = scope === 'show' ? api.markShowWatched(showId(detail.show)) : api.markSeasonWatched(showId(detail.show), selectedSeason);
    operation.then(function () {
      if (api.getToken() !== token) return;
      // A completed write invalidates counts even after navigation. Episode
      // statuses are always refreshed from the service instead of assumed.
      state.my.shows = null;
      state.all.shows = null;
      var revision = ++watchedRevision;
      var sid = String(showId(detail.show));
      var showRevision = (watchedShowRevisions[sid] || 0) + 1;
      watchedShowRevisions[sid] = showRevision;
      var refreshFailed = false;
      var refreshedEpisodes = null;
      var episodesRequest = api.getEpisodes(showId(detail.show)).then(function (response) {
        if (api.getToken() === token && watchedShowRevisions[sid] === showRevision) {
          refreshedEpisodes = api.normalizeEpisodes(response);
          detail.episodes = refreshedEpisodes;
        }
      }).catch(function () { refreshFailed = true; });
      var showsRequest = api.getMyShows().then(function (shows) {
        if (api.getToken() === token && revision === watchedRevision) state.my.shows = sortShows(shows, 'my');
      }).catch(function () { refreshFailed = true; });
      return Promise.all([episodesRequest, showsRequest]).then(function () {
        detail.marking = null;
        if (api.getToken() !== token) return;
        var targetDetail = detail;
        if (generation !== requestGeneration || state.detail !== detail) {
          // The user can leave while a write is pending. Refresh the current
          // list without returning them to the detail that initiated it.
          if (!state.detail && el('login-view').hidden && !player.active && !playPending && (state.tab === 'my' || state.tab === 'all')) {
            var listFocus = document.activeElement && document.activeElement.getAttribute('data-focus');
            openLibrary(state.tab, false, listFocus);
          }
          // Reopening the same show creates a new detail object. Update only
          // its data, retaining the season/page/focus the user has now chosen.
          var current = state.detail;
          if (!current || current.kind === 'movie' || String(showId(current.show)) !== sid || !current.episodes || !refreshedEpisodes || watchedShowRevisions[sid] !== showRevision) return;
          targetDetail = current;
          targetDetail.episodes = refreshedEpisodes;
        }
        var notice = refreshFailed ? 'Отметка сохранена. Обновить все данные пока не удалось.' : scope === 'show' ? 'Сериал отмечен просмотренным.' : 'Сезон отмечен просмотренным.';
        if (player.active || playPending) {
          targetDetail.needsRender = true;
          targetDetail.markNotice = notice;
          return;
        }
        var activeKey = document.activeElement && document.activeElement.getAttribute('data-focus');
        renderEpisodes(activeKey || focusAfter);
        toast(notice);
      });
    }).catch(function (error) {
      detail.marking = null;
      if (generation !== requestGeneration || state.detail !== detail || api.getToken() !== token) return;
      if (player.active || playPending) {
        detail.needsRender = true;
        detail.markNotice = 'Не удалось сохранить отметку. Попробуйте ещё раз.';
        return;
      }
      updateDetailActions();
      if (handleAuth(error)) return;
      toast('Не удалось сохранить отметку. Попробуйте ещё раз.');
      focusKey(focusAfter);
    });
  }

  function playEpisode(episode, file) {
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
      player.start(playback, title(detail.show) + ' · ' + episode.season + ' сезон, ' + episode.episode + ' серия');
    }).catch(function (error) {
      if (generation !== playbackGeneration) return;
      playPending = false;
      el('busy-overlay').hidden = true;
      if (handleAuth(error)) return;
      flushDetailUpdates();
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
      flushDetailUpdates();
      focusKey(lastEpisodeFocus);
      return;
    }
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
      focus(el('login-view').hidden ? el('nav-' + state.tab) : el('login-submit'));
      return;
    }
    if (state.detail && el('login-view').hidden) { backToLibrary(); return; }
    if (Date.now() - lastBack < 2000 && window.tizen && window.tizen.application) {
      try { window.tizen.application.getCurrentApplication().exit(); } catch (ignored) { toast('Закройте приложение кнопкой Home.'); }
    } else {
      lastBack = Date.now();
      toast(window.tizen ? 'Нажмите Назад ещё раз, чтобы закрыть приложение' : 'Вы в главном меню');
    }
  }

  function moveFocus(code) {
    var current = document.activeElement;
    var candidates = Array.prototype.filter.call(document.querySelectorAll('#app-shell button:not(:disabled), #app-shell input:not(:disabled)'), function (item) {
      var rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!current || candidates.indexOf(current) === -1) { focus(candidates[0]); return; }
    var origin = current.getBoundingClientRect();
    var ox = origin.left + origin.width / 2;
    var oy = origin.top + origin.height / 2;
    var horizontal = code === 37 || code === 39;
    var best = null;
    var bestScore = Infinity;
    candidates.forEach(function (item) {
      if (item === current) return;
      var rect = item.getBoundingClientRect();
      var dx = rect.left + rect.width / 2 - ox;
      var dy = rect.top + rect.height / 2 - oy;
      if ((code === 37 && dx >= -1) || (code === 39 && dx <= 1) || (code === 38 && dy >= -1) || (code === 40 && dy <= 1)) return;
      var primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      var secondary = horizontal ? Math.abs(dy) : Math.abs(dx);
      var overlap = horizontal ? rect.bottom > origin.top && rect.top < origin.bottom : rect.right > origin.left && rect.left < origin.right;
      var score = primary + secondary * 3 + (overlap ? 0 : 2000);
      if (score < bestScore) { bestScore = score; best = item; }
    });
    if (best) focus(best);
  }

  function keydown(event) {
    var code = event.keyCode || event.which;
    if (code === 27 || code === 10009) {
      if (backDown) { event.preventDefault(); return; }
      backDown = true;
    }
    if (keyboard.handleKey(event)) return;
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
    if (version) {
      el('app-version').textContent = ' · v' + version;
      el('app-version').hidden = false;
      el('login-version').textContent = 'v' + version;
      el('login-version').hidden = false;
    }
    if (!window.SoapApi || !window.SoapPlayer || !window.SoapKeyboard || !window.SoapCatalog) {
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
    api = new window.SoapApi({ baseUrl: config.apiBase, siteBaseUrl: config.siteBase, token: token });
    player = new window.SoapPlayer({
      onStart: function () {
        el('app-shell').hidden = true;
        document.body.classList.add('playing');
        document.documentElement.classList.add('playing');
      },
      onStop: function (message, reason) {
        var completed = playingEpisode;
        playingEpisode = null;
        document.body.classList.remove('playing');
        document.documentElement.classList.remove('playing');
        el('app-shell').hidden = false;
        flushDetailUpdates();
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
    el('refresh').addEventListener('click', function () {
      if (state.detail && state.detail.kind === 'movie') openMovie(state.detail.show);
      else if (state.detail) openShow(state.detail.show);
      else openLibrary(state.tab, true);
    });
    el('logout').addEventListener('click', function () {
      loginDestination = null;
      api.setToken('');
      storageSet(TOKEN_KEY, null);
      state.my = { shows: null, query: '', page: 0 };
      state.all = { shows: null, query: '', page: 0 };
      state.movies = { shows: null, query: '', page: 0 };
      state.detail = null;
      showLogin();
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
      if (code === 13 || code === 32) sortEnterDown = false;
      if (code === 27 || code === 10009) backDown = false;
    });
    document.addEventListener('click', function (event) {
      if (sortTrigger && event.target !== sortTrigger && !el('sort-menu').contains(event.target)) closeSort(false);
    });
    window.addEventListener('blur', function () { player.resetHold(); keyboard.handleBlur(); sortEnterDown = false; backDown = false; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { keyboard.close(false); closeSort(false); player.resetHold(); }
      // Returning to the series list avoids an AVPlay session left in an invalid state after Home.
      if (document.hidden && (player.active || playPending)) {
        playbackGeneration++;
        playPending = false;
        el('busy-overlay').hidden = true;
        player.stop(true);
      }
    });
    window.addEventListener('pagehide', function () { player.stop(false); });
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
