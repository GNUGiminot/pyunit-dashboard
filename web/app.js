/* ==========================================================================
   Сушилка PyUnit — клиент
   Говорит с PyUnit напрямую (nginx проксирует /api на :5000, один origin),
   счётчик берёт из сервиса-компаньона /stats.
   Работает только с настоящей сушилкой: если PyUnit недоступен, пишет
   «нет связи» и переподключается.
   ========================================================================== */
(function () {
  'use strict';

  // --- Геометрия шкалы ----------------------------------------------------
  // Окружность r=78 -> 490.088. Развёртка 270°, старт в 135° (левый низ).
  var CX = 106, CY = 106, R = 72;
  var STROKE = 28;                       // толщина дуги
  var CAP = STROKE / 2;                  // круглый торец выступает на радиус
  var CIRC = 2 * Math.PI * R;
  var RANGE = { temp: [0, 120], hum: [0, 100] };
  var STALE_MS = 20000;                  // без телеметрии дольше — показания устарели

  // Цвет кольца вычисляется из самого значения: это шкала, а не украшение.
  // Холодная камера — синяя, прогретая уходит в янтарь и красное;
  // сухой воздух бирюзовый, сырой — густо-синий.
  // Переход от синего к янтарному идёт через светлые тона: прямое смешение
  // противоположных цветов даёт серо-оливковую середину, а это как раз
  // комнатная температура — самое частое показание.
  var HEAT_STOPS  = [[0, 0x4a9eff], [0.25, 0x8fc8ff], [0.285, 0xffd47a], [0.45, 0xffb347], [0.62, 0xff7a2f], [1, 0xff3b30]];
  var MOIST_STOPS = [[0, 0x35e0c4], [0.28, 0x3bb8e8], [1, 0x2a5cc8]];

  function rampColor(stops, f) {
    f = clamp01(f);
    for (var i = 1; i < stops.length; i++) {
      if (f <= stops[i][0] || i === stops.length - 1) {
        var a = stops[i - 1], b = stops[i];
        var k = b[0] === a[0] ? 0 : (f - a[0]) / (b[0] - a[0]);
        if (k < 0) k = 0; if (k > 1) k = 1;
        var out = 0;
        for (var sh = 16; sh >= 0; sh -= 8) {
          var ca = (a[1] >> sh) & 255, cb = (b[1] >> sh) & 255;
          out |= Math.round(ca + (cb - ca) * k) << sh;
        }
        return '#' + ('000000' + out.toString(16)).slice(-6);
      }
    }
    return '#ffffff';
  }

  // Смешивает цвет #rrggbb с целевым в долях k (0..1)
  function mixHex(a, b, k) {
    var out = '#';
    for (var sh = 16; sh >= 0; sh -= 8) {
      var ca = parseInt(a.slice(1 + (16 - sh) / 4, 3 + (16 - sh) / 4), 16);
      var cb = parseInt(b.slice(1 + (16 - sh) / 4, 3 + (16 - sh) / 4), 16);
      out += ('0' + Math.round(ca + (cb - ca) * k).toString(16)).slice(-2);
    }
    return out;
  }

  var $ = function (id) { return document.getElementById(id); };
  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var frac = function (v, metric) {
    var r = RANGE[metric];
    return clamp01((v - r[0]) / (r[1] - r[0]));
  };

  // --- Состояние ----------------------------------------------------------
  var state = {
    unit: null,          // {id, name}
    presets: [],         // пресеты, привязанные к блоку
    selectedPreset: null,
    last: null,          // последняя телеметрия
    history: [],         // [{t, temp, rh}]
    rangeSec: 7200,
    ws: null,
    wsTimer: null,
    screen: 'run'
  };

  var STATUS = {
    pending:             { text: 'ожидание',   lamp: 'idle',  phase: '' },
    drying:              { text: 'прогрев',    lamp: 'run',   phase: 'выход на влажность' },
    timer_drying:        { text: 'сушка',      lamp: 'run',   phase: 'выдержка' },
    humidity_storage:    { text: 'хранение',   lamp: 'store', phase: 'хранение по влажности' },
    temperature_storage: { text: 'хранение',   lamp: 'store', phase: 'хранение по температуре' }
  };

  // ======================================================================
  //  Шкалы
  // ======================================================================
  function buildTicks() {
    // Остался только градиент дуги: деления и оцифровки в этом стиле не нужны
    ['temp', 'hum'].forEach(function (metric) {
      var df = document.querySelector('[data-defs="' + metric + '"]');
      if (!df) return;
      df.innerHTML =
        '<linearGradient id="arc-' + metric + '" gradientUnits="userSpaceOnUse" ' +
        'x1="40" y1="30" x2="172" y2="182">' +
        '<stop offset="0" stop-color="#999"/><stop offset="1" stop-color="#ccc"/></linearGradient>';
    });
  }

  function setArc(dialId, metric, value) {
    var dial = $(dialId);
    if (!dial) return;
    var arc = dial.querySelector('.dial__arc');
    var track = dial.querySelector('.dial__track');
    var defs = dial.querySelector('[data-defs]');
    track.setAttribute('stroke-dasharray', CIRC.toFixed(2) + ' ' + CIRC.toFixed(2));

    var known = !(value === null || value === undefined || isNaN(value));
    var f = known ? frac(value, metric) : 0;
    var stops = metric === 'temp' ? HEAT_STOPS : MOIST_STOPS;
    var color = rampColor(stops, f);

    // Круглый торец выступает за конец штриха на половину толщины, поэтому
    // штрих укорачиваем на толщину и сдвигаем начало на CAP: видимая длина
    // дуги тогда точно равна доле f. Пустую дугу не рисуем — иначе останется точка.
    var visible = f * CIRC;
    var dash = visible - STROKE;
    if (f < 0.004) {
      arc.setAttribute('stroke-dasharray', '0 ' + CIRC.toFixed(2));
    } else {
      arc.setAttribute('stroke-dasharray', Math.max(0.01, dash).toFixed(2) + ' ' + CIRC.toFixed(2));
      arc.setAttribute('stroke-dashoffset', (-CAP).toFixed(2));
    }

    // Градиент: светлее в начале, насыщеннее к концу — как на образце
    if (defs) {
      var st = defs.querySelectorAll('stop');
      if (st.length === 2) {
        st[0].setAttribute('stop-color', mixHex(color, '#ffffff', 0.38));
        st[1].setAttribute('stop-color', mixHex(color, '#000000', 0.10));
      }
      arc.style.stroke = 'url(#arc-' + metric + ')';
    }
    dial.style.setProperty('--arc', color);
    document.documentElement.style.setProperty(metric === 'temp' ? '--heat-now' : '--moist-now', color);
    dial.classList.toggle('is-live', known);
  }

  function setTarget(dialId, metric, value) {
    var dial = $(dialId);
    if (!dial) return;
    var g = dial.querySelector('.dial__target');
    // У SVG-элементов нет свойства hidden (оно только у HTMLElement), поэтому
    // управляем атрибутом: иначе [hidden] из разметки скрывает метку навсегда.
    if (value === null || value === undefined || isNaN(value)) { g.setAttribute('hidden', ''); return; }
    g.removeAttribute('hidden');
    g.setAttribute('transform', 'rotate(' + (frac(value, metric) * 360).toFixed(2) + ' ' + CX + ' ' + CY + ')');
  }

  // Плавный счётчик цифр
  var tweens = {};
  var tweenRaf = {};
  var tweenFix = {};
  function setNumber(elId, value, digits) {
    var el = $(elId);
    if (!el) return;
    // Предыдущую анимацию обязательно гасим: иначе на каждом тике телеметрии
    // запускается ещё одна, и несколько rAF-циклов перетирают цифры друг другу.
    if (tweenRaf[elId]) { cancelAnimationFrame(tweenRaf[elId]); tweenRaf[elId] = 0; }
    if (value === null || value === undefined || isNaN(value)) { el.textContent = '--.-'; tweens[elId] = null; return; }
    var from = tweens[elId];
    if (from === null || from === undefined) { tweens[elId] = value; el.textContent = value.toFixed(digits); return; }
    if (Math.abs(value - from) < Math.pow(10, -digits) / 2) { tweens[elId] = value; el.textContent = value.toFixed(digits); return; }
    // В скрытой вкладке (экран телефона погас, приложение свёрнуто) браузер
    // не вызывает requestAnimationFrame вообще. Анимация — украшение, а не
    // способ доставки значения: если кадров не будет, число всё равно верное.
    if (document.visibilityState !== 'visible') {
      tweens[elId] = value; el.textContent = value.toFixed(digits); return;
    }
    var start = performance.now(), dur = 500, a = from, b = value;
    function step(now) {
      var k = Math.min(1, (now - start) / dur);
      var cur = a + (b - a) * (1 - Math.pow(1 - k, 3));
      el.textContent = cur.toFixed(digits);
      tweens[elId] = cur;
      if (k < 1) { tweenRaf[elId] = requestAnimationFrame(step); }
      else { tweens[elId] = b; tweenRaf[elId] = 0; }
    }
    tweenRaf[elId] = requestAnimationFrame(step);
    // Страховка: если кадры так и не придут, доводим значение по таймеру.
    clearTimeout(tweenFix[elId]);
    tweenFix[elId] = setTimeout(function () {
      if (tweenRaf[elId]) { cancelAnimationFrame(tweenRaf[elId]); tweenRaf[elId] = 0; }
      if (tweens[elId] !== b) { tweens[elId] = b; el.textContent = b.toFixed(digits); }
    }, dur + 150);
  }

  // ======================================================================
  //  Отрисовка экрана сушки
  // ======================================================================
  function render() {
    var d = state.last;
    var lamp = $('statusLamp'), txt = $('statusText');

    if (!d) {
      lamp.dataset.state = 'offline';
      txt.textContent = 'нет связи';
      return;
    }

    var st = STATUS[d.status] || STATUS.pending;
    lamp.dataset.state = st.lamp;
    txt.textContent = st.text;

    // Телеметрия идёт раз в секунду. Если её нет дольше STALE_MS — цифры на
    // экране уже не правда: гасим их и пишем, сколько данных нет.
    var stale = state.lastRx && (Date.now() - state.lastRx > STALE_MS);
    document.body.classList.toggle('is-stale', !!stale);
    if (stale) {
      lamp.dataset.state = 'offline';
      txt.textContent = 'нет данных ' + fmtDur((Date.now() - state.lastRx) / 1000);
    }

    $('unitName').textContent = state.unit ? state.unit.name : '—';

    var preset = presetById(d.current_preset_id);
    var mat = $('material');
    if (preset) { mat.hidden = false; mat.textContent = preset.name; } else { mat.hidden = true; }

    // Шкалы
    setNumber('tempValue', d.temperature, 1);
    setNumber('humValue', d.relative_humidity, 1);
    setArc('dialTemp', 'temp', d.temperature);
    setArc('dialHum', 'hum', d.relative_humidity);
    setTarget('dialTemp', 'temp', preset ? preset.temperature : null);
    setTarget('dialHum', 'hum', preset ? preset.humidity : null);
    $('dialTemp').classList.toggle('is-heating', !!d.heater_is_on);

    // Уставки
    $('spTemp').textContent = preset ? preset.temperature + ' °C' : '—';
    $('spHum').textContent = preset ? preset.humidity + ' %' : '—';
    $('spHeater').textContent = (d.heater_temperature === null || d.heater_temperature === undefined)
      ? '—' : d.heater_temperature.toFixed(1) + ' °C';

    // Ход
    var prog = $('progress');
    if (d.status === 'pending' || !preset) {
      prog.hidden = true;
    } else {
      prog.hidden = false;
      $('phaseText').textContent = st.phase;
      var hasLeft = d.time_left_drying !== null && d.time_left_drying !== undefined;
      if (!hasLeft) {
        // Прогрев: обратного отсчёта ещё нет — таймер в PyUnit стартует
        // только когда влажность дойдёт до цели. Показываем время с запуска.
        var el = elapsedSinceStart();
        $('timeLeft').textContent = el.sec === null ? '—' : (el.capped ? '≥ ' : '') + fmtDur(el.sec);
        $('progressFill').style.width = '0%';
        $('elapsedText').textContent = 'идёт прогрев';
        $('etaText').textContent = 'отсчёт с ' + preset.humidity + ' %';
      } else {
        var left = Math.max(0, d.time_left_drying);
        var total = (d.status === 'timer_drying')
          ? preset.dry_time * 60
          : preset.humidity_storage_dry_time * 60;
        $('timeLeft').textContent = fmtDur(left);
        $('progressFill').style.width = (total > 0 ? clamp01(1 - left / total) * 100 : 0).toFixed(1) + '%';
        $('elapsedText').textContent = total > 0 ? 'прошло ' + fmtDur(total - left) : '';
        var presetEnd = Date.now() + left * 1000;
        $('etaText').textContent = (timer.active && timer.stopAt < presetEnd)
          ? 'стоп по таймеру в ' + fmtClock(timer.stopAt)
          : 'готово в ' + fmtClock(presetEnd);
      }
    }

    // Лампы
    lampState('stHeater', d.heater_is_on, 'вкл', 'выкл');
    lampState('stLid', d.servo_is_open, 'открыта', 'закрыта');
    lampState('stFan', d.heater_fan_is_run, 'вкл', 'выкл');

    // Кнопки
    $('btnStart').disabled = !state.selectedPreset || d.status !== 'pending';
    $('btnStop').disabled = d.status === 'pending';
    if (stale) $('btnStart').disabled = true;     // состояние неизвестно — не запускаем вслепую
  }

  function lampState(id, on, yes, no) {
    var el = $(id);
    el.dataset.on = on ? 'true' : 'false';
    el.querySelector('.state__val').textContent = on ? yes : no;
  }

  function presetById(id) {
    if (id === null || id === undefined) return null;
    for (var i = 0; i < state.presets.length; i++) if (state.presets[i].id === id) return state.presets[i];
    return null;
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }
  // «2 ч 10 мин» вместо «2:10», где непонятно, часы это или минуты
  function fmtLong(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + '\u00A0ч ' + m + '\u00A0мин';
    if (m > 0) return m + '\u00A0мин';
    return sec + '\u00A0с';
  }

  function fmtClock(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // Сколько идёт текущая сушка. Считается по истории: отматываем назад,
  // пока статус не станет 'pending'. Если упёрлись в начало буфера —
  // начало сушки в него не попало, и время помечается как «не меньше».
  function elapsedSinceStart() {
    var h = state.history;
    if (!h.length) return { sec: null, capped: false };
    var i = h.length - 1;
    while (i >= 0 && h[i].st && h[i].st !== 'pending') i--;
    var startIdx = i + 1;
    if (startIdx >= h.length) return { sec: null, capped: false };
    return { sec: (Date.now() - h[startIdx].t) / 1000, capped: i < 0 };
  }

  function fmtHours(sec) {
    var h = sec / 3600;
    return h >= 100 ? Math.round(h).toString() : h.toFixed(1);
  }

  // ======================================================================
  //  Самописец
  // ======================================================================
  function drawTrace() {
    var cv = $('traceCanvas');
    if (!cv || state.screen !== 'run') return;
    var css = getComputedStyle(document.documentElement);
    // На графике цвета линий постоянные: если брать их из текущего значения,
    // в простое обе линии становятся голубыми и не различаются.
    var colHeat = css.getPropertyValue('--trace-heat').trim() || '#f08a3a';
    var colMoist = css.getPropertyValue('--trace-moist').trim() || '#2f9fd8';
    var colRule = css.getPropertyValue('--rule').trim();
    var colMute = css.getPropertyValue('--ink-mute').trim();

    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var padL = 26, padR = 26, padT = 8, padB = 16;
    var iw = w - padL - padR, ih = h - padT - padB;

    // сетка
    g.strokeStyle = colRule; g.lineWidth = 1;
    g.beginPath();
    for (var i = 0; i <= 4; i++) {
      var y = padT + (ih * i) / 4 + 0.5;
      g.moveTo(padL, y); g.lineTo(padL + iw, y);
    }
    g.stroke();

    var now = Date.now();
    var from = now - state.rangeSec * 1000;
    var pts = state.history.filter(function (p) { return p.t >= from; });

    g.fillStyle = colMute;
    g.font = '10px ui-monospace, monospace';
    g.textBaseline = 'middle';
    for (var k = 0; k <= 4; k++) {
      var ty = padT + (ih * k) / 4;
      g.textAlign = 'right'; g.fillText(String(120 - k * 30), padL - 4, ty);
      g.textAlign = 'left'; g.fillText(String(100 - k * 25), padL + iw + 4, ty);
    }

    if (pts.length < 2) {
      g.fillStyle = colMute; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = '12px system-ui, sans-serif';
      g.fillText('нет данных за период', w / 2, h / 2);
      return;
    }

    var x = function (t) { return padL + ((t - from) / (now - from)) * iw; };
    var yT = function (v) { return padT + ih - (clamp01(v / 120)) * ih; };
    var yH = function (v) { return padT + ih - (clamp01(v / 100)) * ih; };

    function line(getY, key, color) {
      g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      var started = false;
      for (var j = 0; j < pts.length; j++) {
        var p = pts[j];
        if (p[key] === null || p[key] === undefined || isNaN(p[key])) continue;
        var px = x(p.t), py = getY(p[key]);
        if (!started) { g.moveTo(px, py); started = true; } else { g.lineTo(px, py); }
      }
      g.stroke();
    }
    line(yH, 'rh', colMoist);
    line(yT, 'temp', colHeat);
  }

  function pushHistory(d) {
    var t = parseTs(d.timestamp);
    if (!t) return;
    var h = state.history;
    if (h.length && t <= h[h.length - 1].t) return;
    h.push({ t: t, temp: d.temperature, rh: d.relative_humidity, st: d.status });
    // держим сутки максимум
    var cut = Date.now() - 86400 * 1000;
    while (h.length && h[0].t < cut) h.shift();
  }

  // Бэкенд хранит наивный UTC — дописываем Z, иначе браузер прочтёт как локальное
  function parseTs(s) {
    if (!s) return 0;
    var iso = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z';
    var t = Date.parse(iso);
    return isNaN(t) ? 0 : t;
  }

  // ======================================================================
  //  Связь с PyUnit
  // ======================================================================
  function api(path, opts) {
    return fetch(path, opts || {}).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }

  function connectWs() {
    if (!state.unit) return;
    try { if (state.ws) state.ws.close(); } catch (e) { /* уже закрыт */ }

    var since = new Date(Date.now() - state.rangeSec * 1000)
      .toISOString().replace('Z', '').split('.')[0];
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/api/dashboard/dryer/' + state.unit.id +
              '?start_time=' + encodeURIComponent(since) + '&limit=4000';

    var ws = new WebSocket(url);
    state.ws = ws;

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var rows = Array.isArray(msg) ? msg : (msg && msg.history) ? msg.history : null;
      if (!rows) return;
      if (!Array.isArray(msg)) {
        state.history = [];
        rows.forEach(pushHistory);
      } else {
        rows.forEach(pushHistory);
      }
      if (rows.length) { state.last = rows[rows.length - 1]; state.lastRx = Date.now(); }
      render();
      drawTrace();
    };
    ws.onclose = function () {
      clearTimeout(state.wsTimer);
      state.wsTimer = setTimeout(connectWs, 3000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* и так закрывается */ } };
  }

  function loadStatic() {
    return api('/api/common/units').then(function (units) {
      if (!units || !units.length) throw new Error('нет блоков');
      state.unit = units[0];
      return api('/api/common/presets');
    }).then(function (presets) {
      state.presets = (presets || []).filter(function (p) {
        return (p.dryers || []).some(function (d) { return d.id === state.unit.id; });
      });
      renderPresets();
    });
  }

  function renderPresets() {
    var box = $('presets');
    box.innerHTML = '';
    state.presets.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset' + (state.selectedPreset === p.id ? ' is-on' : '');
      b.textContent = p.name;
      b.title = p.temperature + '°C · ' + p.humidity + '% · ' + p.dry_time + ' мин';
      b.addEventListener('click', function () {
        state.selectedPreset = (state.selectedPreset === p.id) ? null : p.id;
        renderPresets();
        render();
      });
      box.appendChild(b);
    });
  }

  function startDrying() {
    if (!state.selectedPreset || !state.unit) return;
    var hours = timerChoice;
    api('/api/dashboard/control/set-preset/' + state.unit.id + '?preset_id=' + state.selectedPreset, { method: 'POST' })
    .then(function () {
      if (hours <= 0) { toast('Запущено'); return; }
      return timerSend(hours).then(function () {
        toast('Запущено · остановится через ' + hours + '\u00A0ч');
      }, function (e) {
        // Сушка уже идёт, а таймер не встал — об этом обязательно сказать
        toast('Сушка запущена, но таймер НЕ установлен: ' + e.message);
      });
    }).catch(function (e) { toast('Не удалось запустить: ' + e.message); });
  }

  function stopDrying() {
    if (!state.unit) return;
    timerChoice = 0;
    timerSend(0).catch(function () { /* сервис сам снимет устаревший таймер */ });
    api('/api/dashboard/control/set-preset/' + state.unit.id, { method: 'POST' })
      .then(function (r) { toast((r && r.message) || 'Остановлено'); })
      .catch(function (e) { toast('Не удалось остановить: ' + e.message); });
  }

  // ======================================================================
  //  Таймер останова. Живёт в сервисе-компаньоне (stats/app.py), а не в
  //  браузере: телефон может уснуть, а сушилка должна остановиться вовремя.
  // ======================================================================
  var timer = { active: false, stopAt: 0, hours: 0 };
  var timerChoice = 0;           // выбор до запуска, применяется при старте

  function isRunning() { return !!(state.last && state.last.status && state.last.status !== 'pending'); }

  function timerApply(r) {
    timer = (r && r.active)
      ? { active: true, stopAt: r.stop_at * 1000, hours: r.hours }
      : { active: false, stopAt: 0, hours: 0 };
    renderTimer();
  }

  function timerFetch() {
    api('/stats/timer').then(timerApply).catch(function () { /* счётчик недоступен */ });
  }

  function timerSend(hours) {
    return api('/stats/timer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryer_id: state.unit ? state.unit.id : 1, hours: hours })
    }).then(timerApply);
  }

  function renderTimer() {
    var shown = timer.active ? timer.hours : timerChoice;
    document.querySelectorAll('#timerSeg [data-hours]').forEach(function (b) {
      var on = parseFloat(b.dataset.hours) === shown;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var el = $('timerState');
    if (!el) return;
    if (timer.active) {
      var left = Math.max(0, (timer.stopAt - Date.now()) / 1000);
      // Таймер может быть до 48 ч — если остановка не сегодня, нужна дата
      var stopDay = new Date(timer.stopAt), today = new Date();
      var sameDay = stopDay.toDateString() === today.toDateString();
      var when = sameDay ? fmtClock(timer.stopAt)
        : String(stopDay.getDate()).padStart(2, '0') + '.' + String(stopDay.getMonth() + 1).padStart(2, '0') + ' ' + fmtClock(timer.stopAt);
      el.textContent = 'стоп ' + (sameDay ? 'в ' : '') + when + ' · через ' + fmtLong(left);
      el.dataset.on = 'true';
    } else {
      el.textContent = (timerChoice > 0 && !isRunning()) ? 'включится при запуске' : '';
      el.dataset.on = 'false';
    }
  }

  function onTimerChip(hours) {
    timerChoice = hours;
    if (!isRunning()) { renderTimer(); return; }      // применится при запуске
    timerSend(hours).then(function () {
      toast(hours > 0 ? 'Остановится через ' + hours + '\u00A0ч' : 'Таймер снят');
    }, function (e) { toast('Таймер не установлен: ' + e.message); });
  }

  // ======================================================================
  //  Счётчик сушек
  // ======================================================================
  var statsPeriod = 'all';

  function loadStats() {
    api('/stats/summary?period=' + statsPeriod).then(renderStats).catch(function () {
      $('totRuns').textContent = '—';
      $('matList').innerHTML = '<li class="empty">Счётчик недоступен</li>';
      $('sessionList').innerHTML = '';
    });
  }

  function renderStats(s) {
    var runs = $('totRuns');
    runs.textContent = s.totals.runs;
    if (s.totals.active) {
      var extra = document.createElement('small');
      extra.className = 'total__extra';
      extra.textContent = '+1 идёт';
      runs.appendChild(extra);
    }
    $('totHours').textContent = fmtHours(s.totals.seconds);
    $('totHeat').textContent = fmtHours(s.totals.heater_seconds);

    var max = 0;
    s.materials.forEach(function (m) { if (m.seconds > max) max = m.seconds; });
    var ml = $('matList');
    ml.innerHTML = '';
    if (!s.materials.length) ml.innerHTML = '<li class="empty">Пока ни одной сушки</li>';
    s.materials.forEach(function (m) {
      var li = document.createElement('li');
      li.className = 'mat';
      li.innerHTML =
        '<span class="mat__name"></span>' +
        '<span class="mat__num"></span>' +
        '<span class="mat__bar"><i class="mat__fill"></i></span>';
      li.querySelector('.mat__name').textContent = m.name;
      li.querySelector('.mat__num').textContent =
        (m.runs ? m.runs + ' × · ' : '') + fmtHours(m.seconds) + ' ч' + (m.active ? ' · идёт' : '');
      li.querySelector('.mat__fill').style.width = (max ? (m.seconds / max) * 100 : 0).toFixed(1) + '%';
      ml.appendChild(li);
    });

    var sl = $('sessionList');
    sl.innerHTML = '';
    if (!s.sessions.length) sl.innerHTML = '<li class="empty">История пуста</li>';
    s.sessions.slice(0, 20).forEach(function (x) {
      var li = document.createElement('li');
      li.className = 'sess';
      li.dataset.outcome = x.outcome;
      li.innerHTML = '<span class="sess__date"></span><span class="sess__mat"></span><span class="sess__dur"></span>';
      var dt = new Date(parseTs(x.started_at));
      // Время в базе — UTC; parseTs переводит его в часовой пояс браузера
      li.querySelector('.sess__date').textContent =
        String(dt.getDate()).padStart(2, '0') + '.' + String(dt.getMonth() + 1).padStart(2, '0') +
        ' ' + fmtClock(dt.getTime());
      li.querySelector('.sess__mat').textContent = x.material;
      li.querySelector('.sess__dur').textContent = fmtDur(x.seconds);
      sl.appendChild(li);
    });
  }

  // ======================================================================
  //  Оболочка: экраны, тема, уведомления
  // ======================================================================
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function goto(name) {
    state.screen = name;
    $('screen-run').hidden = name !== 'run';
    $('screen-stats').hidden = name !== 'stats';
    $('screen-more').hidden = name !== 'more';
    document.querySelectorAll('.tab[data-goto]').forEach(function (b) {
      var on = b.dataset.goto === name;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (name === 'stats') loadStats();
    if (name === 'more') setupLinks();
    if (name === 'run') requestAnimationFrame(drawTrace);
  }

  // Полный интерфейс PyUnit живёт на :5000 того же хоста. Адрес строится от
  // текущего, поэтому работает и по IP, и по имени, и с телефона.
  var FULL_PORT = 5000;
  function fullUrl(path) {
    return location.protocol + '//' + location.hostname + ':' + FULL_PORT + '/' + path;
  }
  function setupLinks() {
    $('moreHost').textContent = location.hostname + ':' + FULL_PORT;
    document.querySelectorAll('.link[data-path]').forEach(function (a) {
      a.setAttribute('href', fullUrl(a.dataset.path));
    });
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('dryer-theme'); } catch (e) { /* приватный режим */ }
    // Если тему уже проставил кто-то снаружи (просмотрщик, киоск-обёртка) —
    // уважаем её; наш выбор применяем только поверх 'auto'.
    var pre = document.documentElement.dataset.theme;
    if (pre !== 'light' && pre !== 'dark') document.documentElement.dataset.theme = saved || 'auto';
    $('themeBtn').addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      var cur = document.documentElement.dataset.theme || 'auto';
      var next = order[(order.indexOf(cur) + 1) % order.length];
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('dryer-theme', next); } catch (e) { /* не сохранится — не критично */ }
      $('themeBtn').textContent = next === 'light' ? '☀' : next === 'dark' ? '☾' : '◐';
      toast('Тема: ' + (next === 'auto' ? 'как в системе' : next === 'light' ? 'светлая' : 'тёмная'));
      requestAnimationFrame(drawTrace);
    });
  }

  function init() {
    buildTicks();
    initTheme();

    document.querySelectorAll('.tab[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { goto(b.dataset.goto); });
    });
    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-range]').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        state.rangeSec = parseInt(b.dataset.range, 10);
        drawTrace();
        connectWs();
      });
    });
    document.querySelectorAll('[data-period]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-period]').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        statsPeriod = b.dataset.period;
        loadStats();
      });
    });
    $('btnStart').addEventListener('click', startDrying);
    $('btnStop').addEventListener('click', stopDrying);
    document.querySelectorAll('#timerSeg [data-hours]').forEach(function (b) {
      b.addEventListener('click', function () { onTimerChip(parseFloat(b.dataset.hours)); });
    });
    setInterval(renderTimer, 1000);
    setInterval(function () { if (state.screen === 'stats') loadStats(); }, 15000);
    setInterval(function () { if (state.last) render(); }, 2000);   // заметить, что данные перестали идти       // обратный отсчёт тикает и без телеметрии
    setInterval(timerFetch, 10000);       // таймер могли поставить/снять с другого устройства
    timerFetch();
    window.addEventListener('resize', drawTrace);
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', function () { requestAnimationFrame(drawTrace); });
    }

    // PWA: ставится на главный экран. Регистрируем только по http(s),
    // чтобы открытие файла с диска не сыпало ошибками в консоль.
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* не критично */ });
    }

    // Нет связи — так и пишем и переподключаемся, пока PyUnit не ответит
    // (например, после перезагрузки устройства).
    (function boot(attempt) {
      loadStatic().then(function () {
        connectWs();
        timerFetch();
        render();
        if (attempt > 0) toast('Связь с сушилкой восстановлена');
      }).catch(function () {
        render();
        if (attempt === 0) toast('Нет связи с сушилкой — переподключаюсь');
        setTimeout(function () { boot(attempt + 1); }, Math.min(15000, 3000 + attempt * 2000));
      });
    })(0);

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
