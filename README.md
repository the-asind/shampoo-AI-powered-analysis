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

## Локальный запуск

```bash
npm install
cp .env.example .env
npm run dev:api
npm run dev
```

Если `OPENAI_API_KEY` не задан, backend использует локальные эвристические правила и все равно сохраняет результат в SQLite.
В production без `RECAPTCHA_SECRET_KEY` защищённые API-методы отклоняют запросы. Для frontend нужен `VITE_RECAPTCHA_SITE_KEY`.

## Production

```bash
docker build -t shampoo-asind-dev .
docker run --rm -p 3000:3000 --env-file .env -v shampoo-data:/app/data shampoo-asind-dev
```

Для Kubernetes см. `k8s/deployment.yaml`. Перед применением замените image и secret.
