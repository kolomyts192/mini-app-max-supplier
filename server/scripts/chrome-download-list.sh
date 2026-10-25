#!/bin/sh
# Скачивает файлы по списку URL через локальный Chrome (см. chrome-fetch.mjs) в папку на хосте.
# Уже скачанные файлы пропускает. Запуск из контейнера tools:
#   sh scripts/chrome-download-list.sh /repo/opendata-cache/fsa/rds-urls.txt /repo/opendata-cache/fsa/rds 'D:\PROJECTS\MAX BUIZNESS APP\opendata-cache\fsa\rds'
set -u
list="$1"      # файл со списком URL (путь в контейнере)
local_dir="$2" # та же папка, как её видит контейнер
host_dir="$3"  # папка на хосте (путь Windows) — туда пишет Chrome
cd "$(dirname "$0")/.."
while read -r url; do
  url=$(printf '%s' "$url" | tr -d '\r') # список мог быть сохранён в Windows (CRLF)
  [ -z "$url" ] && continue
  name=$(basename "$url")
  if [ -s "$local_dir/$name" ]; then echo "skip $name"; continue; fi
  ok=0
  for attempt in 1 2 3; do
    if node scripts/chrome-fetch.mjs download "$url" "$host_dir"; then ok=1; break; fi
    echo "retry $attempt: $name"; sleep 5
  done
  [ "$ok" = 1 ] || echo "FAILED $name"
done < "$list"
echo "done: $(ls "$local_dir" | grep -c '\.7z$') files"
