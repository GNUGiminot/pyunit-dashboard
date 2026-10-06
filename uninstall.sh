#!/usr/bin/env bash
# PyUnit Dashboard — удаление. PyUnit не затрагивается.
#
#   ./uninstall.sh          убрать контейнеры, историю сушек сохранить
#   ./uninstall.sh --purge  убрать всё: контейнеры, историю сушек, каталог
set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="sudo docker"; fi
if $DOCKER compose version >/dev/null 2>&1; then DC="$DOCKER compose"
elif [ "$DOCKER" = "docker" ]; then DC="docker-compose"; else DC="sudo docker-compose"; fi

if [ "$PURGE" = 1 ]; then
  $DC down --volumes --rmi local --remove-orphans
  echo "Контейнеры, образ и история сушек удалены."
  cd /
  rm -rf "$DIR"
  echo "Каталог $DIR удалён."
else
  $DC down --remove-orphans
  echo "Контейнеры удалены. История сушек сохранена в томе Docker."
  echo "Удалить всё вместе с историей: $DIR/uninstall.sh --purge"
fi
