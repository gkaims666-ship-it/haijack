#!/data/data/com.termux/files/usr/bin/bash
# Local Claude Code — установка в Termux (Android).
# Запуск:  bash install-termux.sh
set -e

if [ -z "$PREFIX" ] || [ ! -d "$PREFIX" ]; then
  echo "Похоже, это не Termux. На Linux/macOS используйте: npm install -g ."
  exit 1
fi

cd "$(dirname "$0")"
echo "=== Local Claude Code: установка в Termux ==="

pkg update -y
# nodejs-lts стабильнее на Android; git — для работы с репозиториями
pkg install -y nodejs-lts git || pkg install -y nodejs git

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<18||(a===18&&b<17)){console.error("Нужен Node >= 18.17");process.exit(1)}'
echo "[ok] Node $(node --version)"

# Зависимостей нет — ничего не компилируется на телефоне
npm install -g . --no-audit --no-fund

# В Termux нет /usr/bin/env — исправляем shebang у установленного файла
if command -v termux-fix-shebang >/dev/null 2>&1; then
  termux-fix-shebang "$(npm root -g)/local-claude-code/bin/lcc.js" 2>/dev/null || true
fi

mkdir -p "$HOME/.lcc"
if [ ! -f "$HOME/.lcc/.env" ]; then
  cp .env.example "$HOME/.lcc/.env"
  chmod 600 "$HOME/.lcc/.env"
  echo "[ok] Создан ~/.lcc/.env — впишите ANTHROPIC_API_KEY (или ключ спросят при первом запуске)"
fi

lcc --version >/dev/null && echo "[ok] Команда lcc установлена"
cat <<'EOF'

Готово. Дальше:
  termux-setup-storage        # (один раз) доступ к памяти телефона: ~/storage/shared
  cd ~/my-project             # или git clone ... && cd ...
  lcc

Совет: проекты лучше держать в домашней папке Termux (~), а не в ~/storage/shared —
во внешней памяти Android нельзя ставить права на исполнение и не работают симлинки.
EOF
