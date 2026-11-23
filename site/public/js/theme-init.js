// Ставит тему до первой отрисовки, чтобы страница не мигала.
// Порядок: ?theme=light|dark в адресе (для проверки) → сохранённый выбор → системная.
(function () {
  var forced = new URLSearchParams(location.search).get('theme');
  var saved = null;
  try {
    saved = localStorage.getItem('health.theme');
  } catch (e) {}
  var theme = forced === 'light' || forced === 'dark' ? forced : saved;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
})();
