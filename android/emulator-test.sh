#!/usr/bin/env bash
# Проверка APK в эмуляторе: приложение ставится, встроенный Node запускается,
# веб-интерфейс программы отвечает на запросы и требует ключ доступа.
set -euo pipefail

APK="${1:?укажите путь к apk}"
PKG=com.localclaudecode.app

adb install -r "$APK"
adb logcat -c
# Диалог доступа к файлам в тесте не нужен: выдаём доступ заранее
adb shell appops set "$PKG" MANAGE_EXTERNAL_STORAGE allow || true
adb shell am start -W -n "$PKG/.MainActivity"

ready=""
for _ in $(seq 1 60); do
  if adb logcat -d -s LCC:I | grep -q "server ready on port"; then ready=1; break; fi
  if adb logcat -d -s LCC:E | grep -q "startup failed\|node failed\|node exited"; then break; fi
  sleep 2
done

echo "----- журнал приложения -----"
adb logcat -d -s LCC
if [ -z "$ready" ]; then
  echo "----- сбои -----"
  adb logcat -d -b crash | tail -n 80 || true
  adb logcat -d | grep -iE "$PKG|libnode|native-lib|FATAL|UnsatisfiedLink" | tail -n 80 || true
  adb shell run-as "$PKG" cat files/.lcc/web.log 2>/dev/null || true
  echo "ОШИБКА: приложение не запустило сервер"
  exit 1
fi

port="$(adb logcat -d -s LCC:I | sed -n 's/.*server ready on port \([0-9]*\).*/\1/p' | tail -n 1)"
adb forward tcp:18080 "tcp:$port"

# Без ключа сервер обязан отказать
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/)"
[ "$code" = "401" ] || { echo "ОШИБКА: без ключа ожидался ответ 401, получен $code"; exit 1; }

sleep 3
if ! adb shell pidof "$PKG" >/dev/null; then
  echo "ОШИБКА: приложение завершилось после запуска"
  adb logcat -d -b crash | tail -n 80 || true
  exit 1
fi

# Страница интерфейса должна отрисоваться во встроенном браузере: ищем её заголовок в дереве экрана
page=""
for _ in $(seq 1 10); do
  adb shell uiautomator dump /sdcard/lcc-ui.xml >/dev/null 2>&1 || true
  if adb shell cat /sdcard/lcc-ui.xml 2>/dev/null | grep -q "Local Claude Code"; then page=1; break; fi
  sleep 3
done
adb exec-out screencap -p > emulator-screen.png || true
if [ -z "$page" ]; then
  echo "ОШИБКА: интерфейс не появился на экране. Дерево экрана:"
  adb shell cat /sdcard/lcc-ui.xml 2>/dev/null | head -c 3000 || true
  exit 1
fi

echo "OK: приложение работает, сервер на порту $port требует ключ, интерфейс отрисован"
