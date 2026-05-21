# Bybit Pump & Volume Scanner

Сканер фьючерсов Bybit с алертами в Telegram. Работает на GitHub Actions, бесплатно, 24/7.

## Что делает

Каждые 15 минут запускаются два сканера:

- **`scan.js`** — ищет монеты с ростом цены > 20% за 24 часа
- **`volume-scan.js`** — ищет монеты со всплеском объёма ×5+ за последний час (среднее за предыдущие 23 часа)

Алерты приходят в Telegram. Каждая монета алертится не чаще раза в 6 часов.

## Файлы

| Файл | Назначение |
|---|---|
| `scan.js` | Сканер пампов цены |
| `volume-scan.js` | Сканер всплесков объёма |
| `config.json.example` | Шаблон настроек (пороги, кулдауны) |
| `state.json` | Память: какие монеты уже алертили (пампы) |
| `volume-state.json` | Память: какие монеты уже алертили (объём) |
| `.github/workflows/scan.yml` | GitHub Actions: запуск по cron `*/15 * * * *` |

## Настройка

1. Форкни / скопируй репозиторий
2. В GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   - `TELEGRAM_BOT_TOKEN` — токен бота от [@BotFather](https://t.me/BotFather)
   - `TELEGRAM_CHAT_ID` — твой chat_id (из `https://api.telegram.org/bot<TOKEN>/getUpdates`)
3. Включи Actions: **Settings → Actions → General → Allow all actions**
4. Первый запуск: **Actions → Bybit Pump & Volume Scanner → Run workflow**

## Локальный запуск

```bash
cp config.json.example config.json
# Отредактируй config.json — впиши telegramBotToken и telegramChatId
node scan.js
node volume-scan.js
```

## Параметры в config.json

| Параметр | Описание |
|---|---|
| `pumpThresholdPercent` | Порог роста цены за 24ч (%) |
| `minTurnover24hUsd` | Минимальный 24ч-оборот для попадания в скан |
| `alertCooldownHours` | Не алертить одну монету чаще раза в N часов |
| `volumeSpikeMultiplier` | Во сколько раз должен превышать объём среднего |
| `volumeSpikeMinHourTurnoverUsd` | Минимальный абсолютный 1ч-объём |
| `volumeSpikeMinDailyTurnoverUsd` | Фильтр: сканируем только пары с 24ч-оборотом > этого |
| `volumeSpikeCooldownHours` | Кулдаун для алертов объёма |
