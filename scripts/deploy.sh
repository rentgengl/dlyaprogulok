#!/bin/sh
# Выкладка на сервер: код API и озвучки, зависимости, перезапуск, веб-версия.
# Запуск из корня проекта: ./scripts/deploy.sh
set -e
HOST=${DEPLOY_HOST:-root@185.221.214.50}
KEY=${DEPLOY_KEY:-$HOME/.ssh/rasskazhi_vps}
PUBLIC_URL=${PUBLIC_URL:-https://dlyaprogulok.ru}
SSH="ssh -i $KEY -o IdentitiesOnly=yes"

cd "$(dirname "$0")/.."

echo "→ Проверки"
(cd server && npx tsc --noEmit && npm test --silent > /dev/null)

echo "→ Сервер"
rsync -az --delete -e "$SSH" --exclude node_modules --exclude 'server/data' --exclude '.env' --exclude '.env.bak*' --exclude '.DS_Store' \
  server tts docker-compose.yml README.md "$HOST:/opt/rasskazhi/"
$SSH "$HOST" 'cd /opt/rasskazhi/server && npm ci --omit=dev --no-audit --no-fund --silent \
  && cd /opt/rasskazhi && docker compose up -d --build tts \
  && systemctl restart rasskazhi && sleep 2 && curl -sf localhost:3000/api/health > /dev/null && echo "  API работает"'

echo "→ Веб ($PUBLIC_URL)"
(cd app && rm -rf dist && EXPO_PUBLIC_API_URL="$PUBLIC_URL" npx expo export --platform web > /dev/null)
rsync -az --delete --timeout=60 -e "$SSH" app/dist/ "$HOST:/var/www/rasskazhi/"
curl -sf -m 20 -o /dev/null "$PUBLIC_URL/" && echo "✓ Готово: $PUBLIC_URL"
