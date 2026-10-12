# -*- coding: utf-8 -*-
"""Счётчик сушек для PyUnit.

Почему отдельная база: PyUnit при КАЖДОМ запуске стирает таблицу dryer_logs
(CLEAR_LOGS_ON_STARTUP=True), так что история сушек там не живёт. Этот
сервис раз в несколько секунд читает свежие строки телеметрии (только
чтение), восстанавливает по ним сессии сушки и хранит их у себя.

Сессия = от первого статуса не-pending до одного из событий:
  * переход в хранение (humidity_storage / temperature_storage) -> completed
  * переход в pending при остатке времени                        -> aborted
  * переход в pending, когда таймер уже дошёл до нуля            -> completed
Хранение сушкой не считается.

Таймер останова: пользователь задаёт «остановить через N часов». Таймер живёт
здесь, на устройстве, а не в браузере — телефон может уснуть, и сушилка
осталась бы греть. По истечении сервис вызывает тот же API PyUnit, что и
кнопка «Стоп». Таймер ТОЛЬКО останавливает, нагрев сам никогда не включает.
Если сушилка остановилась раньше (вручную или по своему таймеру), таймер
снимается, чтобы не остановить следующую, не связанную с ним сушку.
"""
import json
import os
import sqlite3
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

SRC = os.environ.get('DB_PATH', '/data/pyunit.db')
OWN = os.environ.get('OWN_DB', '/state/stats.db')
POLL = float(os.environ.get('POLL_SECONDS', '5'))
PYUNIT_API = os.environ.get('PYUNIT_API', 'http://host.docker.internal:5000').rstrip('/')
TIMER_MIN_H, TIMER_MAX_H = 0.25, 48.0   # пределы таймера, часов
STALE_GRACE = 90.0     # сек: сушилка уже стоит дольше — таймер больше не нужен
GAP = 120.0            # разрыв телеметрии больше этого не считается временем работы
DRYING = ('drying', 'timer_drying')
STORAGE = ('humidity_storage', 'temperature_storage')

lock = threading.Lock()


def own():
    c = sqlite3.connect(OWN, timeout=10)
    c.execute('PRAGMA journal_mode=WAL')
    c.executescript('''
      CREATE TABLE IF NOT EXISTS sessions(
        id INTEGER PRIMARY KEY, started_at TEXT, material TEXT, preset_id INTEGER,
        seconds REAL, heater_seconds REAL, outcome TEXT);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
    ''')
    return c


def kv_get(c, k, default=None):
    r = c.execute('SELECT v FROM kv WHERE k=?', (k,)).fetchone()
    return json.loads(r[0]) if r else default


def kv_put(c, k, v):
    c.execute('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
              (k, json.dumps(v)))


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '')).timestamp()


def preset_names(src):
    try:
        return {r[0]: r[1] for r in src.execute('SELECT id, name FROM presets')}
    except sqlite3.Error:
        return {}


def finish(c, act, outcome):
    if act['seconds'] < 60:     # случайный клик «старт — стоп» не считаем
        return
    c.execute('INSERT INTO sessions(started_at,material,preset_id,seconds,heater_seconds,outcome) '
              'VALUES(?,?,?,?,?,?)',
              (act['started_at'], act['material'], act['preset_id'],
               act['seconds'], act['heater'], outcome))


def step(c, act, row, names):
    """Один шаг автомата. row = (timestamp, status, preset_id, heater_is_on, time_left)."""
    t, status, preset_id, heater, left = row
    now = ts(t)
    if act:
        dt = now - act['last']
        if 0 < dt <= GAP:
            act['seconds'] += dt
            if heater:
                act['heater'] += dt
        act['last'] = now
        if left is not None:
            act['left'] = left
            act['timer'] = True

    if status in DRYING:
        if not act:
            act = {'started_at': t, 'preset_id': preset_id,
                   'material': names.get(preset_id, 'Без пресета'),
                   'seconds': 0.0, 'heater': 0.0, 'last': now, 'left': None, 'timer': False}
        return act
    if status in STORAGE:
        if act:
            finish(c, act, 'completed')
        return None
    # pending и всё незнакомое
    if act:
        # Завершена: таймер пресета дошёл до конца или сушку остановил таймер
        # пользователя (это плановое окончание). Иначе — остановлена вручную.
        done = act.get('stopped_by_timer') or (
            act['timer'] and act['left'] is not None and act['left'] <= 120)
        finish(c, act, 'completed' if done else 'aborted')
    return None


def ingest():
    if not os.path.exists(SRC):
        return
    c = own()
    try:
        src = sqlite3.connect('file:%s?mode=ro' % SRC, uri=True, timeout=10)
    except sqlite3.Error:
        c.close()
        return
    try:
        last = kv_get(c, 'last_ts', '')
        act = kv_get(c, 'active', None)
        # Часы на устройстве без RTC при загрузке врут и потом скачут назад:
        # если самая свежая строка старше сохранённой метки — база была очищена.
        top = src.execute('SELECT MAX(timestamp) FROM dryer_logs').fetchone()[0]
        if top and last and top < last:
            last = ''
        names = preset_names(src)
        rows = src.execute(
            'SELECT timestamp,status,current_preset_id,heater_is_on,time_left_drying '
            'FROM dryer_logs WHERE timestamp > ? ORDER BY timestamp LIMIT 20000', (last,)).fetchall()
        for row in rows:
            act = step(c, act, row, names)
            last = row[0]
        if rows:
            kv_put(c, 'last_status', rows[-1][1])
        kv_put(c, 'last_ts', last)
        kv_put(c, 'active', act)
        c.commit()
    finally:
        src.close()
        c.close()


# ============================ таймер останова ============================

def timer_get(c):
    t = kv_get(c, 'timer', None)
    if not t:
        return {'active': False}
    left = max(0.0, t['stop_at'] - time.time())
    return {'active': True, 'dryer_id': t['dryer_id'], 'hours': t['hours'],
            'set_at': t['set_at'], 'stop_at': t['stop_at'], 'remaining': left}


def timer_set(dryer_id, hours):
    hours = float(hours)
    if not (TIMER_MIN_H <= hours <= TIMER_MAX_H):
        raise ValueError('таймер от %.2f до %.0f ч' % (TIMER_MIN_H, TIMER_MAX_H))
    now = time.time()
    c = own()
    try:
        kv_put(c, 'timer', {'dryer_id': int(dryer_id), 'hours': hours,
                            'set_at': now, 'stop_at': now + hours * 3600})
        c.commit()
        return timer_get(c)
    finally:
        c.close()


def timer_cancel():
    c = own()
    try:
        kv_put(c, 'timer', None)
        c.commit()
        return {'active': False}
    finally:
        c.close()


def pyunit_stop(dryer_id):
    """Тот же вызов, что делает кнопка «Стоп» в интерфейсе PyUnit."""
    req = urllib.request.Request(
        '%s/api/dashboard/control/set-preset/%d' % (PYUNIT_API, int(dryer_id)),
        data=b'', method='POST')
    with urllib.request.urlopen(req, timeout=10) as r:
        return 200 <= r.status < 300


def timer_tick():
    c = own()
    try:
        t = kv_get(c, 'timer', None)
        if not t:
            return
        now = time.time()
        status = kv_get(c, 'last_status', None)
        # Сушилка уже стоит — значит её остановили иначе; таймер снимаем,
        # чтобы он не оборвал следующую сушку, к которой не относится.
        if status == 'pending' and now - t['set_at'] > STALE_GRACE:
            kv_put(c, 'timer', None)
            c.commit()
            print('timer: сушилка уже остановлена, таймер снят', flush=True)
            return
        if now >= t['stop_at']:
            try:
                ok = pyunit_stop(t['dryer_id'])
            except Exception as e:
                print('timer: не удалось остановить, повтор на следующем шаге:', e, flush=True)
                return
            if ok:
                kv_put(c, 'timer', None)
                act = kv_get(c, 'active', None)
                if act:
                    act['stopped_by_timer'] = True    # счётчик запишет её как завершённую
                    kv_put(c, 'active', act)
                c.commit()
                print('timer: сушка остановлена по таймеру (%.2f ч)' % t['hours'], flush=True)
    finally:
        c.close()


# ============================ история для графика ============================

def history(seconds, points, dryer_id=1):
    """Вся телеметрия окна, сжатая до ~points точек усреднением по интервалам.

    PyUnit отдаёт историю только целиком (сутки — ~86 тыс. записей, ~20 МБ),
    а с ограничением по числу записей обрезает окно. Здесь SQLite сам
    группирует записи по интервалам — быстро и с полным покрытием окна.
    """
    seconds = max(60, min(int(seconds), 7 * 86400))
    points = max(50, min(int(points), 2000))
    bucket = max(1.0, seconds / float(points))
    since = (datetime.utcnow() - timedelta(seconds=seconds)).isoformat(sep=' ')
    src = sqlite3.connect('file:%s?mode=ro' % SRC, uri=True, timeout=10)
    try:
        rows = src.execute(
            'SELECT AVG(julianday(timestamp)), AVG(temperature), AVG(relative_humidity) '
            'FROM dryer_logs WHERE dryer_id = ? AND timestamp >= ? '
            'GROUP BY CAST((julianday(timestamp) - julianday(?)) * 86400.0 / ? AS INTEGER) '
            'ORDER BY 1', (int(dryer_id), since, since, bucket)).fetchall()
    finally:
        src.close()
    pts = []
    for jd, t, rh in rows:
        ms = int(round((jd - 2440587.5) * 86400000))     # юлианский день -> Unix, мс
        pts.append([ms, None if t is None else round(t, 2), None if rh is None else round(rh, 2)])
    return {'bucket': bucket, 'points': pts}


def active_session():
    c = own()
    try:
        a = kv_get(c, 'active', None)
        if not a:
            return {'active': False}
        return {'active': True, 'started_at': a['started_at'], 'material': a['material'],
                'seconds': a['seconds']}
    finally:
        c.close()


def summary(period):
    c = own()
    try:
        where, args, cut = '', (), None
        if period in ('30', '365'):
            # sep=' ' — в базе метки вида '2026-10-12 16:33:34'; с 'T' строковое
            # сравнение отрезало бы сушки граничного дня периода
            cut = (datetime.utcnow() - timedelta(days=int(period))).isoformat(sep=' ')
            where, args = 'WHERE started_at >= ?', (cut,)
        rows = c.execute('SELECT started_at,material,seconds,heater_seconds,outcome '
                         'FROM sessions %s ORDER BY started_at DESC' % where, args).fetchall()
        totals = {'runs': 0, 'seconds': 0.0, 'heater_seconds': 0.0, 'aborted': 0, 'active': 0}
        mats = {}

        def mat(name):
            return mats.setdefault(name, {'name': name, 'runs': 0, 'seconds': 0.0,
                                          'done_seconds': 0.0, 'active': False})

        for started, name, sec, hs, out in rows:
            totals['seconds'] += sec
            totals['heater_seconds'] += hs
            if out == 'completed':
                totals['runs'] += 1
                m = mat(name)
                m['runs'] += 1
                m['seconds'] += sec
                m['done_seconds'] += sec
            else:
                totals['aborted'] += 1

        # Идущая сушка учитывается сразу: её время входит в часы работы и в
        # материал, но число сушек — только завершённые (прерванная не должна
        # засчитаться как сделанная), идущая отдаётся отдельно.
        current = None
        act = kv_get(c, 'active', None)
        if act and (cut is None or act['started_at'] >= cut):
            totals['seconds'] += act['seconds']
            totals['heater_seconds'] += act['heater']
            totals['active'] = 1
            m = mat(act['material'])
            m['seconds'] += act['seconds']
            m['active'] = True
            current = {'started_at': act['started_at'], 'material': act['material'],
                       'seconds': act['seconds'], 'outcome': 'active'}

        for m in mats.values():
            # среднее — только по завершённым, иначе идущая сушка его исказит
            m['avg_seconds'] = (m['done_seconds'] / m['runs']) if m['runs'] else None
            del m['done_seconds']

        sessions = [{'started_at': r[0], 'material': r[1], 'seconds': r[2], 'outcome': r[4]}
                    for r in rows[:50]]
        if current:
            sessions.insert(0, current)
        return {
            'totals': totals,
            'materials': sorted(mats.values(), key=lambda m: -m['seconds']),
            'sessions': sessions,
            'active': bool(current),
        }
    finally:
        c.close()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip('/')
        if path in ('/stats/summary', '/summary'):
            q = parse_qs(u.query).get('period', ['all'])[0]
            body = json.dumps(summary(q), ensure_ascii=False).encode('utf-8')
            code = 200
        elif path in ('/stats/history', '/history'):
            q = parse_qs(u.query)
            try:
                res = history(q.get('seconds', ['7200'])[0], q.get('points', ['480'])[0],
                              q.get('dryer', ['1'])[0])
                body, code = json.dumps(res).encode('utf-8'), 200
            except (ValueError, sqlite3.Error) as e:
                body, code = json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'), 400
        elif path in ('/stats/active', '/active'):
            body, code = json.dumps(active_session(), ensure_ascii=False).encode('utf-8'), 200
        elif path in ('/stats/timer', '/timer'):
            c = own()
            try:
                body = json.dumps(timer_get(c)).encode('utf-8')
            finally:
                c.close()
            code = 200
        elif path in ('/stats/health', '/health'):
            body, code = b'{"ok":true}', 200
        else:
            body, code = b'{"error":"not found"}', 404
        self.reply(code, body)

    def reply(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlparse(self.path).path.rstrip('/') not in ('/stats/timer', '/timer'):
            return self.reply(404, b'{"error":"not found"}')
        try:
            n = int(self.headers.get('Content-Length') or 0)
            data = json.loads(self.rfile.read(n) or b'{}')
            hours = float(data.get('hours', 0))
            with lock:
                res = timer_cancel() if hours <= 0 else timer_set(data.get('dryer_id', 1), hours)
            self.reply(200, json.dumps(res).encode('utf-8'))
        except (ValueError, TypeError) as e:
            self.reply(400, json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'))

    def do_DELETE(self):
        if urlparse(self.path).path.rstrip('/') not in ('/stats/timer', '/timer'):
            return self.reply(404, b'{"error":"not found"}')
        with lock:
            res = timer_cancel()
        self.reply(200, json.dumps(res).encode('utf-8'))


def loop():
    while True:
        try:
            with lock:
                ingest()
                timer_tick()
        except Exception as e:      # не даём потоку умереть
            print('ingest error:', e, flush=True)
        time.sleep(POLL)


if __name__ == '__main__':
    os.makedirs(os.path.dirname(OWN), exist_ok=True)
    own().close()
    threading.Thread(target=loop, daemon=True).start()
    print('stats service on :8000, source=%s' % SRC, flush=True)
    ThreadingHTTPServer(('0.0.0.0', 8000), H).serve_forever()
