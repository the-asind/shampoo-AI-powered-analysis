# shampoo.asind.dev

Независимый одностраничник для рейтинга шампуней и проверки состава по INCI с ИИ-проверкой.

## Архитектура

- React + Vite для UI.
- Fastify API в том же контейнере.
- SQLite + WAL для рейтинга, AI-разборов и заявок.
- OpenAI-compatible `/chat/completions` endpoint через `OPENAI_BASE_URL` и `OPENAI_API_KEY`.
- Google reCAPTCHA v3 для проверки анализа состава и отправки заявок.

SQLite выбран намеренно: для одной слабой VPS и компактной таблицы лидеров это быстрее и проще, чем отдельная СУБД. В Kubernetes приложение запускается в одном replica с PVC и стратегией `Recreate`.

## API

- `GET /api/health`
- `GET /api/shampoos?audience=normal|oily|sensitive`
- `POST /api/analyze` `{ "composition": "...", "recaptchaToken": "..." }`
- `POST /api/submissions` `{ "name": "...", "sourceUrl": "...", "composition": "...", "analysis": {...}, "recaptchaToken": "..." }`
- `POST /api/visits` `{ "path": "/" }`
- `GET /api/admin/summary`, `GET /api/admin/analyses`, `GET /api/admin/submissions` with `Authorization: Bearer $ADMIN_TOKEN`

## Локальный запуск

```bash
npm install
cp .env.example .env
npm run dev:api
npm run dev
```

Если `OPENAI_API_KEY` не задан, backend использует локальные эвристические правила и все равно сохраняет результат в SQLite.
Если в окружении явно задан `HTTPS_PROXY` или `HTTP_PROXY`, AI-запросы к OpenAI-compatible endpoint отправляются через этот прокси. Остальные backend-запросы этим кодом не проксируются.
В production без `RECAPTCHA_SECRET_KEY` защищённые API-методы отклоняют запросы. Для frontend нужен `VITE_RECAPTCHA_SITE_KEY`.
Для `/api/analyze` и `/api/submissions` действует квота по IP отдельно на каждое действие: по умолчанию 1 запрос в минуту и 10 запросов в сутки. Настройки: `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_DAY`.
Админка доступна по `/admin`. Для неё нужен `ADMIN_TOKEN` в `.env`; токен вводится в UI и отправляется только как Bearer token к `/api/admin/*`. Посещения хранят не сырой IP, а SHA-256 хэш с `VISIT_HASH_SALT` или `ADMIN_TOKEN` как солью.

Если запрос не дошёл до ИИ, смотри логи контейнера:

```bash
docker logs shampoo-asind-dev --tail 100
```

Полезные события:

- `recaptcha_failed` — запрос остановлен до ИИ; в поле `recaptcha.reason` будет причина, например `recaptcha_low_score`, `recaptcha_action_mismatch` или `recaptcha_request_error`.
- `rate_limited` — сработала квота; в `rateLimit.reason` будет минутный или суточный лимит.
- `AI analysis failed, using heuristic analysis` — reCAPTCHA и квота пройдены, но OpenAI-compatible endpoint не ответил; лог показывает `endpointHost`, `proxyEnabled`, `proxyHost`, `timeoutMs` и безопасный текст ошибки без ключей.
- `AI analysis succeeded` и `analysis_completed` — ИИ ответил; `durationMs`, `aiMs` и `totalMs` показывают фактическую длительность.

Если клиент видит `504 Gateway Time-out`, а в backend-логах позже появляется `analysis_completed`, значит nginx перестал ждать раньше, чем закончился ИИ-запрос. Например `aiMs: 72497` означает 72.5 секунды ожидания ИИ. В таком случае либо держи `OPENAI_TIMEOUT_MS` ниже nginx timeout, например `45000`, либо увеличивай nginx `proxy_read_timeout` для API.

```nginx
proxy_connect_timeout 10s;
proxy_send_timeout 180s;
proxy_read_timeout 180s;
```

Для reCAPTCHA v3 не стоит начинать с очень высокого порога. Разумный стартовый `RECAPTCHA_MIN_SCORE` — `0.5`, дальше порог лучше подбирать по реальным логам.

## Production

```bash
cp .env.example .env
docker compose up -d --build
```

По умолчанию приложение слушает `127.0.0.1:3001` на хосте. Nginx можно проксировать на `http://127.0.0.1:3001`.
Для корректных IP-квот nginx должен передавать адрес клиента:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header Host $host;
```

Для Kubernetes см. `k8s/deployment.yaml`. Перед применением замените image и secret.
