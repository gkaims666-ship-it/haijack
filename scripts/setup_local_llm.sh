#!/usr/bin/env bash
# Подготовка локальной модели для haijack через Ollama (Linux, macOS, Termux).
#
#   bash scripts/setup_local_llm.sh --model <имя модели> [--fallback <имя модели>] [--write-env]
#
# Проверяет, что Ollama установлена, запускает сервер, скачивает указанную модель и показывает
# строки для файла настроек. С флагом --write-env дописывает их в ~/.lcc/.env.
# Нужна модель с поддержкой вызова инструментов (tool calling).
# Скачивание весов занимает от нескольких минут до часов — запускайте в своём терминале.
set -euo pipefail

MODEL=""
FALLBACK=""
WRITE_ENV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --model=*) MODEL="${1#--model=}"; shift ;;
    --fallback) FALLBACK="${2:-}"; shift 2 ;;
    --fallback=*) FALLBACK="${1#--fallback=}"; shift ;;
    --write-env) WRITE_ENV=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$MODEL" ]; then
  echo "Укажите модель: --model <имя>, например --model qwen2.5-coder:14b" >&2
  exit 2
fi

HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
case "$HOST" in http://*|https://*) BASE="$HOST" ;; *) BASE="http://$HOST" ;; esac

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama не установлена." >&2
  if echo "${PREFIX:-}" | grep -q com.termux; then
    echo "Termux: pkg install ollama" >&2
  else
    echo "Установка: curl -fsSL https://ollama.com/install.sh | sh   (или скачайте с https://ollama.com/download)" >&2
  fi
  exit 1
fi

alive() { curl -fsS --max-time 3 "$BASE/api/tags" >/dev/null 2>&1; }

if ! alive; then
  echo "Запускаю сервер Ollama…"
  mkdir -p "$HOME/.lcc"
  nohup ollama serve >"$HOME/.lcc/ollama.log" 2>&1 &
  for _ in $(seq 1 30); do alive && break; sleep 1; done
  alive || { echo "Сервер Ollama не запустился. Журнал: $HOME/.lcc/ollama.log" >&2; exit 1; }
fi
echo "Сервер Ollama работает: $BASE"

for m in "$MODEL" $FALLBACK; do
  echo "Скачиваю модель $m (может занять много времени)…"
  ollama pull "$m"
done

ENV_LINES="LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=$BASE/v1
LOCAL_LLM_API_KEY=ollama
LOCAL_LLM_MODEL=$MODEL
LOCAL_LLM_NUM_CTX=16384
LOCAL_LLM_TIMEOUT=180000"
[ -n "$FALLBACK" ] && ENV_LINES="$ENV_LINES
LOCAL_LLM_FALLBACK_MODEL=$FALLBACK"

echo
echo "Готово. Настройки для haijack:"
echo "$ENV_LINES"
if [ "$WRITE_ENV" = 1 ]; then
  mkdir -p "$HOME/.lcc"
  FILE="$HOME/.lcc/.env"
  touch "$FILE"; chmod 600 "$FILE"
  TMP="$(mktemp)"
  grep -vE '^(LLM_PROVIDER|LCC_PROVIDER|LCC_MODEL|LOCAL_LLM_(BASE_URL|API_KEY|MODEL|FALLBACK_MODEL|NUM_CTX|TIMEOUT))=' "$FILE" >"$TMP" || true
  printf '%s\n' "$ENV_LINES" >>"$TMP"
  mv "$TMP" "$FILE"
  echo "Записано в $FILE"
else
  echo
  echo "Добавьте эти строки в ~/.lcc/.env или запустите скрипт с флагом --write-env."
fi
