# Pay Blood Kraken Backend

Node.js + Express + Prisma (PostgreSQL). Поддерживает:
- Регистрация игрока из Rust-плагина -> выдача постоянного externalId формата AAAA-#####-AAAAA.
- Линковка Telegram Mini App (проверка initData).
- Кошелёк BLKR (Solana SPL): пополнения через центральный кошелёк (ATA), сканирование входящих переводов, зачисление в баланс.
- Заявки на вывод BLKR (ручной/авто в будущем), админ-обзор.
- Маркет лотов: создание из плагина, покупка с транзакциями, PendingDelivery для доставки в игру.

## Быстрый старт локально

1. Установить зависимости:
   npm install

2. Создать .env на основе .env.example (DATABASE_URL, TELEGRAM_BOT_TOKEN, SOLANA_RPC_URL, BLKR_MINT, MERCHANT_WALLET и т.д.)

3. Prisma:
   npm run prisma:generate
   npm run prisma:migrate

4. Старт:
   npm run dev

5. Проверка:
   curl http://localhost:8080/health

## Деплой на Railway

- Подключить репозиторий GitHub, добавить плагин PostgreSQL.
- В Variables указать: DATABASE_URL, NODE_ENV=production, SERVER_API_KEY, TELEGRAM_BOT_TOKEN, SOLANA_RPC_URL, BLKR_MINT, MERCHANT_WALLET, BLKR_DECIMALS.
- Deploy command: npm run prisma:deploy
- Start command: npm start

## Основные API (префикс /api)

- /rust/register [POST] — регистрация игрока (X-Server-Key)
- /rust/user/:steamId [GET] — инфо по игроку (X-Server-Key)
- /rust/market/listings [POST] — создать лот (X-Server-Key)
- /rust/deliveries/pending [GET] — очередь доставок (X-Server-Key)
- /rust/deliveries/:id/status [POST] — статус доставки (X-Server-Key)

- /telegram/link [POST] — линковка Telegram Mini App initData ↔ externalId

- /wallet/link [POST] — привязать Solana адрес пользователя
- /wallet/deposit/check [POST] — проверить поступления BLKR и зачислить
- /wallet/withdraw [POST] — заявка на вывод
- /wallet/profile/:externalId [GET] — профиль/баланс

- /market/listings [GET] — ленты лотов
- /market/listings/:id/buy [POST] — покупка лота

- /admin/withdrawals [GET] — заявки на вывод (X-Admin-Key)
- /admin/withdrawals/:id/status [POST] — смена статуса (X-Admin-Key)

Примечания:
- BigInt сериализуется в строки.
- Денежные операции проводятся в транзакциях Prisma.
- Адреса Solana валидируются по base58 (32 байта).
- Сканы депозитов выполняются через JSON-RPC Solana.