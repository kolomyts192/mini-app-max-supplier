#!/bin/sh
# Подбор упорядоченной шкалы для диаграмм дашборда (светлая тема, белая поверхность).
cd "$(dirname "$0")"
for p in '#A3A9FF,#5F69FD,#1927FC' '#9AA1FF,#5C66FD,#1927FC' '#8F97FF,#555FFD,#1927FC'; do
  echo "== $p"
  node validate_palette.js "$p" --mode light --surface '#FFFFFF' --ordinal | grep -E 'PASS|FAIL|→'
done
