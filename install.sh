#!/usr/bin/env bash
# PyUnit Dashboard — установка и обновление одной командой.
#
#   curl -fsSL https://raw.githubusercontent.com/GNUGiminot/pyunit-dashboard/main/install.sh | bash
#
# или из клона репозитория:  ./install.sh
#
# Повторный запуск = обновление: настройки (.env) и история сушек сохраняются.
# Нужен уже установленный и запущенный PyUnit: https://github.com/xatang/PyUnit
set -euo pipefail

REPO="GNUGiminot/pyunit-dashboard"
BRANCH="${DASHBOARD_BRANCH:-main}"
INSTALL_DIR="${DASHBOARD_DIR:-}"
UI_PORT="${UI_PORT:-}"
PYUNIT_DIR="${PYUNIT_DIR:-}"
PYUNIT_PORT="${PYUNIT_PORT:-}"
PROJECT="pyunit-dashboard"
UI_CONTAINER="pyunit-dashboard-ui"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \342\234\223 %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
fail() { printf '\n  \342\234\227 %s\n\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Использование: install.sh [параметры]

  --dir ПУТЬ          куда установить панель (по умолчанию ~/pyunit-dashboard)
  --port ПОРТ         порт панели (по умолчанию 5001, при занятости — следующий свободный)
  --pyunit-dir ПУТЬ   каталог PyUnit, если его не удаётся найти автоматически
  --pyunit-port ПОРТ  порт PyUnit, если его не удаётся найти автоматически
  -h, --help          эта справка
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          INSTALL_DIR="$2"; shift 2 ;;
    --port)         UI_PORT="$2"; shift 2 ;;
    --pyunit-dir)   PYUNIT_DIR="$2"; shift 2 ;;
    --pyunit-port)  PYUNIT_PORT="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              fail "неизвестный параметр: $1 (см. --help)" ;;
  esac
done

say "========================================="
say " PyUnit Dashboard — установка/обновление"
say " надстройка над https://github.com/xatang/PyUnit"
say "========================================="

# --- Откуда ставим: из клона или скачиваем ---------------------------------
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
FROM_CLONE=0
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -d "$SCRIPT_DIR/web" ]; then
  FROM_CLONE=1
  [ -z "$INSTALL_DIR" ] && INSTALL_DIR="$SCRIPT_DIR"
fi
[ -z "$INSTALL_DIR" ] && INSTALL_DIR="$HOME/pyunit-dashboard"

# --- Docker ------------------------------------------------------------------
say ""
say "Docker..."
command -v docker >/dev/null 2>&1 || fail "Docker не найден. Сначала установите PyUnit — его run.sh ставит Docker: https://github.com/xatang/PyUnit"
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif sudo docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  fail "нет доступа к Docker (ни напрямую, ни через sudo)"
fi
ok "Docker: $DOCKER"

if $DOCKER compose version >/dev/null 2>&1; then
  DC="$DOCKER compose"
elif command -v docker-compose >/dev/null 2>&1; then
  if [ "$DOCKER" = "docker" ]; then DC="docker-compose"; else DC="sudo docker-compose"; fi
else
  fail "не найден ни 'docker compose', ни 'docker-compose'"
fi
ok "Compose: $DC"

# --- Сохранённые настройки прошлой установки -------------------------------
read_env() { [ -f "$INSTALL_DIR/.env" ] && sed -n "s/^$1=//p" "$INSTALL_DIR/.env" | tail -1 || true; }
[ -z "$UI_PORT" ]     && UI_PORT="$(read_env UI_PORT)"
[ -z "$PYUNIT_DIR" ]  && PYUNIT_DIR="$(read_env PYUNIT_DIR)"
[ -z "$PYUNIT_PORT" ] && PYUNIT_PORT="$(read_env PYUNIT_PORT)"

# --- Поиск PyUnit -----------------------------------------------------------
say ""
say "PyUnit..."
PU_CONTAINER="$($DOCKER ps --format '{{.Names}}\t{{.Image}}' | awk -F'\t' '$2 ~ /(^|\/)pyunit(:|$)/ {print $1; exit}')"
[ -z "$PU_CONTAINER" ] && $DOCKER ps --format '{{.Names}}' | grep -qx pyunit && PU_CONTAINER="pyunit"

if [ -n "$PU_CONTAINER" ]; then
  ok "контейнер: $PU_CONTAINER"
  if [ -z "$PYUNIT_DIR" ]; then
    DB_SRC="$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/app/pyunit.db"}}{{.Source}}{{end}}{{end}}' "$PU_CONTAINER")"
    [ -n "$DB_SRC" ] && PYUNIT_DIR="$(dirname "$DB_SRC")"
  fi
  if [ -z "$PYUNIT_PORT" ]; then
    PYUNIT_PORT="$($DOCKER port "$PU_CONTAINER" 5000/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
  fi
else
  warn "запущенный контейнер PyUnit не найден"
fi

[ -n "$PYUNIT_DIR" ] || fail "не удалось определить каталог PyUnit. Запустите PyUnit или укажите --pyunit-dir"
[ -n "$PYUNIT_PORT" ] || PYUNIT_PORT="5000"
for f in pyunit.db pyunit.db-wal pyunit.db-shm; do
  # Несуществующий файл docker смонтировал бы как КАТАЛОГ — это сломало бы базу
  [ -f "$PYUNIT_DIR/$f" ] || fail "нет файла $PYUNIT_DIR/$f — это точно каталог PyUnit? (--pyunit-dir)"
done
ok "каталог: $PYUNIT_DIR"
ok "порт PyUnit: $PYUNIT_PORT"

# --- Порт панели ---------------------------------------------------------------
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
OURS_RUNNING=0
$DOCKER ps --format '{{.Names}}' | grep -qx "$UI_CONTAINER" && OURS_RUNNING=1
if [ -z "$UI_PORT" ]; then
  UI_PORT=5001
  if [ "$OURS_RUNNING" = 0 ]; then
    while port_busy "$UI_PORT"; do UI_PORT=$((UI_PORT + 1)); [ "$UI_PORT" -gt 5050 ] && fail "не нашлось свободного порта 5001–5050 (--port)"; done
  fi
elif [ "$OURS_RUNNING" = 0 ] && port_busy "$UI_PORT"; then
  fail "порт $UI_PORT уже занят (--port)"
fi
ok "порт панели: $UI_PORT"

# --- Файлы ---------------------------------------------------------------------
say ""
if [ "$FROM_CLONE" = 1 ] && [ "$INSTALL_DIR" = "$SCRIPT_DIR" ]; then
  ok "файлы: из клона $INSTALL_DIR"
else
  say "Загрузка $REPO@$BRANCH..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" | tar xz -C "$TMP" --strip-components=1
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$URL" | tar xz -C "$TMP" --strip-components=1
  else fail "нужен curl или wget"; fi
  [ -f "$TMP/docker-compose.yml" ] || fail "архив скачан, но в нём нет docker-compose.yml"
  mkdir -p "$INSTALL_DIR"
  # Обновляем только файлы приложения; .env (настройки) не трогаем
  rm -rf "$INSTALL_DIR/web" "$INSTALL_DIR/stats" "$INSTALL_DIR/nginx"
  cp -R "$TMP/web" "$TMP/stats" "$TMP/nginx" "$INSTALL_DIR/"
  cp "$TMP/docker-compose.yml" "$TMP/install.sh" "$TMP/uninstall.sh" "$INSTALL_DIR/"
  [ -f "$TMP/README.md" ] && cp "$TMP/README.md" "$INSTALL_DIR/"
  chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/uninstall.sh"
  ok "файлы: $INSTALL_DIR"
fi

cat > "$INSTALL_DIR/.env" <<EOF
# Создан install.sh. Можно править вручную и перезапустить install.sh.
COMPOSE_PROJECT_NAME=$PROJECT
PYUNIT_DIR=$PYUNIT_DIR
PYUNIT_PORT=$PYUNIT_PORT
UI_PORT=$UI_PORT
EOF
ok "настройки: $INSTALL_DIR/.env"

# --- Запуск ----------------------------------------------------------------------
say ""
say "Запуск..."
cd "$INSTALL_DIR"
# Сначала down: старый docker-compose 1.x падает при пересоздании существующего
# контейнера на новом Docker (KeyError: 'ContainerConfig'). Том с историей
# сушек при этом сохраняется.
$DC down --remove-orphans >/dev/null 2>&1 || true
$DC up -d --build >/dev/null || fail "не удалось запустить контейнеры (запустите вручную: cd $INSTALL_DIR && $DC up -d --build)"
ok "контейнеры запущены"

# --- Проверка ------------------------------------------------------------------
say ""
say "Проверка..."
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 5 "$1" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then wget -qO- -T 5 "$1" >/dev/null 2>&1
  else return 0; fi
}
BASE="http://127.0.0.1:$UI_PORT"
UI_OK=0; API_OK=0; STATS_OK=0
for _ in $(seq 1 30); do
  fetch "$BASE/" && UI_OK=1
  fetch "$BASE/api/common/ping" && API_OK=1
  fetch "$BASE/stats/health" && STATS_OK=1
  [ $UI_OK = 1 ] && [ $API_OK = 1 ] && [ $STATS_OK = 1 ] && break
  sleep 2
done
[ $UI_OK = 1 ]    && ok "интерфейс отвечает"       || warn "интерфейс не отвечает: $DC logs dashboard-ui"
[ $API_OK = 1 ]   && ok "связь с PyUnit есть"      || warn "нет связи с PyUnit на порту $PYUNIT_PORT"
[ $STATS_OK = 1 ] && ok "счётчик и таймер работают" || warn "сервис счётчика не отвечает: $DC logs dashboard-stats"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$IP" ] && IP="localhost"
say ""
say "========================================="
say " Готово:  http://$IP:$UI_PORT"
say " PyUnit:  http://$IP:$PYUNIT_PORT"
say " Обновить: повторно запустить install.sh"
say " Удалить:  $INSTALL_DIR/uninstall.sh"
say "========================================="
