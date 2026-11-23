// Ставит тему до первой отрисовки, чтобы страница не мигала.
// Порядок: ?theme=light|dark в адресе (для проверки) → сохранённый выбор → системная.
(function () {
  var forced = new URLSearchParams(location.search).get('theme');
  var saved = null;
  try {
    saved = localStorage.getItem('medkarta.theme');
    if (saved == null) {
      // До переименования проекта ключ назывался иначе — переносим выбор один раз.
      saved = localStorage.getItem('health.theme');
      if (saved != null) {
        localStorage.setItem('medkarta.theme', saved);
        localStorage.removeItem('health.theme');
      }
    }
  } catch (e) {}
  var theme = forced === 'light' || forced === 'dark' ? forced : saved;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
})();
