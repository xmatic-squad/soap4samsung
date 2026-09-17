(function (root) {
  'use strict';

  var LAYOUTS = {
    ru: ['1234567890-+', 'йцукенгшщзхъ', 'фывапролджэё', 'ячсмитьбю,.?'],
    en: ['1234567890-+', 'qwertyuiop()', 'asdfghjkl;:"', 'zxcvbnm,./?\'']
  };
  var MAX_LENGTH = 100;

  function SoapKeyboard(options) {
    this.dialog = document.getElementById('search-keyboard');
    this.display = document.getElementById('keyboard-query');
    this.keys = document.getElementById('keyboard-keys');
    this.onApply = options.onApply;
    this.language = 'ru';
    this.active = false;
    this.enterDown = false;
    this.rows = [];
    this.draft = '';
  }

  SoapKeyboard.prototype.open = function (query, opener, enterDown) {
    if (this.active) return;
    this.active = true;
    this.opener = opener;
    this.draft = String(query || '').slice(0, MAX_LENGTH);
    // Opening OK must be released before it can enter a character, including
    // remotes that send repeated keydowns without setting event.repeat.
    this.enterDown = !!enterDown;
    this.dialog.hidden = false;
    document.getElementById('app-shell').setAttribute('aria-hidden', 'true');
    this.render();
    this.updateDisplay();
    this.rows[1][0].focus();
  };

  SoapKeyboard.prototype.close = function (apply, restoreFocus) {
    if (!this.active) return;
    this.active = false;
    this.enterDown = false;
    this.dialog.hidden = true;
    document.getElementById('app-shell').removeAttribute('aria-hidden');
    if (restoreFocus !== false && this.opener) this.opener.focus();
    if (apply) this.onApply(this.draft);
  };

  SoapKeyboard.prototype.updateDisplay = function () {
    this.display.textContent = this.draft || 'Введите название';
    this.display.classList.toggle('muted', !this.draft);
    this.display.scrollLeft = this.display.scrollWidth;
  };

  SoapKeyboard.prototype.edit = function (text) {
    this.draft = (this.draft + text).slice(0, MAX_LENGTH);
    this.updateDisplay();
  };

  SoapKeyboard.prototype.render = function () {
    var self = this;
    while (this.keys.firstChild) this.keys.removeChild(this.keys.firstChild);
    this.rows = [];
    function row(items, actionRow) {
      var container = document.createElement('div');
      container.className = 'keyboard-row' + (actionRow ? ' keyboard-actions' : '');
      var buttons = [];
      items.forEach(function (item) {
        var key = document.createElement('button');
        key.type = 'button';
        key.textContent = item.label;
        key.className = item.action === 'apply' ? 'primary-button' : '';
        if (item.label === '⌫') key.setAttribute('aria-label', 'Удалить последний символ');
        if (item.action === 'language') key.setAttribute('aria-label', self.language === 'ru' ? 'Русская раскладка. Переключить на английскую' : 'Английская раскладка. Переключить на русскую');
        key.addEventListener('click', function () {
          if (!self.active || self.enterDown) return;
          if (!item.action) self.edit(item.label);
          else if (item.action === 'space') self.edit(' ');
          else if (item.action === 'delete') { self.draft = self.draft.slice(0, -1); self.updateDisplay(); }
          else if (item.action === 'clear') { self.draft = ''; self.updateDisplay(); }
          else if (item.action === 'apply') self.close(true);
          else if (item.action === 'cancel') self.close(false);
          else if (item.action === 'language') {
            self.language = self.language === 'ru' ? 'en' : 'ru';
            self.render();
            self.rows[self.rows.length - 1][0].focus();
          }
        });
        container.appendChild(key);
        buttons.push(key);
      });
      self.keys.appendChild(container);
      self.rows.push(buttons);
    }
    LAYOUTS[this.language].forEach(function (letters) {
      row(letters.split('').map(function (letter) { return { label: letter }; }));
    });
    row([
      { label: this.language === 'ru' ? 'РУ → EN' : 'EN → РУ', action: 'language' },
      { label: 'Пробел', action: 'space' },
      { label: '⌫', action: 'delete' },
      { label: 'Очистить', action: 'clear' },
      { label: 'Найти', action: 'apply' },
      { label: 'Отмена', action: 'cancel' }
    ], true);
  };

  SoapKeyboard.prototype.move = function (code, backwards) {
    var row = 1;
    var column = 0;
    var found = false;
    for (var i = 0; i < this.rows.length; i++) {
      var index = this.rows[i].indexOf(document.activeElement);
      if (index !== -1) { row = i; column = index; found = true; break; }
    }
    if (!found) { this.rows[row][column].focus(); return; }
    if (code === 9) {
      column += backwards ? -1 : 1;
      if (column < 0) { row = (row + this.rows.length - 1) % this.rows.length; column = this.rows[row].length - 1; }
      else if (column >= this.rows[row].length) { row = (row + 1) % this.rows.length; column = 0; }
    } else if (code === 37 || code === 39) {
      column = Math.max(0, Math.min(this.rows[row].length - 1, column + (code === 37 ? -1 : 1)));
    } else {
      var destination = Math.max(0, Math.min(this.rows.length - 1, row + (code === 38 ? -1 : 1)));
      column = Math.min(this.rows[destination].length - 1, Math.floor((column + 0.5) * this.rows[destination].length / this.rows[row].length));
      row = destination;
    }
    this.rows[row][column].focus();
  };

  SoapKeyboard.prototype.handleKey = function (event) {
    if (!this.active) return false;
    var code = event.keyCode || event.which;
    event.preventDefault();
    if (code === 10009 || code === 27) this.close(false);
    else if ((code >= 37 && code <= 40) || code === 9) this.move(code, event.shiftKey);
    else if (code === 13) {
      if (!this.enterDown && !event.repeat) {
        // Use the same action as pointer clicks, then latch until keyup. This
        // also blocks the native click that some engines dispatch after Enter.
        var selected = document.activeElement;
        if (this.rows.some(function (row) { return row.indexOf(selected) !== -1; })) selected.click();
        this.enterDown = true;
      }
    } else if (code === 8 || code === 46) {
      this.draft = this.draft.slice(0, -1);
      this.updateDisplay();
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key && event.key.length === 1) this.edit(event.key);
    return true;
  };

  SoapKeyboard.prototype.handleKeyUp = function (event) {
    if ((event.keyCode || event.which) === 13) this.enterDown = false;
  };

  SoapKeyboard.prototype.handleBlur = function () {
    // A key released while another app has focus may never send us keyup.
    this.enterDown = false;
  };

  root.SoapKeyboard = SoapKeyboard;
}(window));
