#!/usr/bin/env bash
# Проверка самоулучшения внутри приложения в эмуляторе: агенты (на мок-сервере API) меняют код
# приложения, самопроверка проходит во встроенном Node, новая версия устанавливается, и приложение
# перезапускает программу без переустановки.
#
# Нужна отладочная сборка: только она принимает заранее известный ключ доступа.
set -euo pipefail

APK="${1:?укажите путь к отладочному apk}"
PKG=com.localclaudecode.app
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install "$APK"
adb logcat -c
adb shell appops set "$PKG" MANAGE_EXTERNAL_STORAGE allow || true
adb shell am start -W -n "$PKG/.MainActivity" --es lcc_token "$TOKEN"

port=""
for _ in $(seq 1 60); do
  port="$(adb logcat -d -s LCC:I | sed -n 's/.*server ready on port \([0-9]*\).*/\1/p' | tail -n 1)"
  [ -n "$port" ] && break
  sleep 2
done
if [ -z "$port" ]; then
  echo "ОШИБКА: приложение не запустило сервер"
  adb logcat -d -s LCC
  exit 1
fi
adb forward tcp:18081 "tcp:$port"

# Скрипт поднимает мок-сервер API на этой машине (эмулятор видит её как 10.0.2.2) и управляет приложением
if ! node android/self-test.mjs "http://127.0.0.1:18081" "$TOKEN"; then
  echo "----- журнал приложения -----"
  adb logcat -d -s LCC || true
  adb logcat -d -b crash | tail -n 60 || true
  adb shell run-as "$PKG" cat files/.lcc/web.log 2>/dev/null || true
  exit 1
fi
