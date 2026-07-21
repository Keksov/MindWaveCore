# undo-legacy-removal — полное выпиливание миграционных глаголов undo.json

Кандидат №1 из финального отчёта фичи `undo-versioned-log` (леджер закрыт 2026-07-21, коммит
8642351): версионный лог принят владельцем, миграционные глаголы оставались «до миграции всех
реальных проектов». Этот план закрывает хвост: глаголы и весь клиентский путь миграции v3
удаляются целиком.

## 1. Требования владельца (дословно)

1. (2026-07-21) «go 1.» — старт кандидата №1: «Полное выпиливание миграционных глаголов
   (`GET /api/projects/undo` + `PUT null`) — после того как все ваши реальные проекты мигрируют».
2. Квиз UR0.1 (2026-07-21), вопрос «forestmed.» (проект forestmeditation не мигрирован,
   undo.json 312 КБ / 9 шагов / вчерашний): ответ **«Журнал не жалко»** — выпиливаем сразу,
   журнал не переносится, undo.json удаляется.
3. Квиз UR0.1 (2026-07-21), вопрос «Бандлы» (pre-VL export-бандлы несут журнал в поле `undo`):
   ответ **«Игнорировать с warning»** — при импорте поле пропускается с предупреждением,
   в undo.json больше не пишется.

## 2. Контекст: что именно выпиливается (инвентарь rg по всем репо)

Сервер (MindWaveCore/server):
- `server.ts:1444-1470` — роут `/api/projects/undo` (GET журнала + POST c null) и импорт
  `ProjectUndoResponse` (строка 30). Файл с NUL-байтом — только точечные Edit, поиск `rg --text`.
- `project-store.ts` — `getUndoJournal`/`putUndoJournal` (интерфейс :275 + импл :482/:491),
  `UndoFileData`/`isUndoFileData` (:315/:321), запись `undo.json` при импорте pre-VL бандла
  (:588-596), `legacyUndoBytes` в `buildInfo` (:685). `UNDO_FILE_NAME` остаётся только для
  rm-гигиены при импорте.
- `project-store.test.ts` — тесты 410/чтения (:279-295), суммы undoJournalBytes (:297-321),
  pre-VL бандла (:425-438).
- `version-log-conformance.test.ts` — импорт `planV3Migration` (:18) и S14-тест миграции (:245+).

Клиент (GnauralCore/ui) + протокол (SharedPasCore):
- `protocol.ts` — `ProjectUndoResponse` (:394), `ProjectUndoPutRequest` (:399), устаревшие
  комментарии (:350, :369, :405-407).
- `project-api.ts` — `fetchUndoJournal` (:103), `putUndoJournal` (:112).
- `use-project.ts` — `readProjectUndoJournalFor` (:452), `deleteProjectUndoJournalFor` (:468),
  устаревшие комментарии (:57, :192 — сам `appendProjectUndoLogNowFor` живёт: им пользуется
  side-снапшот mid-history save).
- `use-gtrack-lanes.ts` [CRLF!] — `migrateLegacyV3Journal` (:806-837) + вызов (:541),
  `isGTrackUndoJournal` из импорта (:12, больше не нужен здесь), комментарий про 5МБ (:633).
- `undo-log-adoption.ts` — `planV3Migration`/`UndoLogMigrationPlan` (:142-197) + describe-блок
  в `undo-log-adoption.test.ts` (:104-132).
- `use-undo-journal-settings.ts` — устаревший комментарий про 5МБ-кап (:3).

Больше потребителей нет: rg по MindWaveCore/ui, GnauralCore (вне перечисленного), SharedPasCore,
FPC-код — пусто.

## 3. Решения

- **UR-D1 (предусловие закрыто владельцем).** Скан реального корня
  `C:\Users\1\AppData\Local\KKSoundCore\projects` (userDataRoot по умолчанию, override пуст):
  `wakeup-c737408e` — мигрирован (undo-log/ есть, undo.json нет); `tibetanbowls-30b1d187` — пуст;
  `forestmeditation-7550d1c2` — НЕ мигрирован (undo.json 312 598 байт, v3, 9 шагов
  point-insert/move «Meditative voice», cursor=1, updatedAt 2026-07-20). Владелец: «Журнал не
  жалко» — журнал не переносится; undo.json удаляется вручную на шаге UR2.1 (последним, после
  деплоя кода). Если владелец успеет открыть проект в приложении до перезапуска бекенда, старая
  миграция отработает сама и файл исчезнет — шаг UR2.1 это учитывает (проверка перед удалением).
- **UR-D2 (бандлы).** Поле `undo` pre-VL бандлов при импорте игнорируется: запись в undo.json
  исчезает навсегда, вместо неё `console.warn` сервера с размером проигнорированного журнала.
  Поле остаётся описанным в `ProjectExportBundle` (файлы бандлов в природе его содержат) с
  пометкой «ignored». rm undo.json при overwrite-импорте остаётся как гигиена.
- **UR-D3 (buildInfo).** `undoJournalBytes` считает только `undo-log/`; `legacyUndoBytes`
  выпиливается. Случайный undo.json на диске становится невидим для UI — после UR-D1/UR-D2
  источников таких файлов не существует.
- **UR-D4 (отставка S14).** Клиентская одноразовая миграция v3 выведена из эксплуатации целиком:
  все символы из раздела 2. Конформанс-тест S14 удаляется; замещающий негативный тест живёт на
  уровне project-store («pre-VL бандл: undo игнорируется, undo.json не создаётся, лог пуст»).
  Историческая спека в `undo-versioned-log-plan.md` не редактируется (done-фича) — отставка
  зафиксирована здесь.

## 4. Шаги

Фаза 0 — план:
- **UR0.1** план + леджер + квиз-решения; docs-коммит.

Фаза 1 — выпиливание (порядок держит каждый репозиторий зелёным в точке его коммита):
- **UR1.1** сервер: роут + store-методы + импорт-warning + buildInfo + тесты project-store.
  Конформанс на этом шаге ещё зелёный (planV3Migration жив до UR1.2).
- **UR1.2** клиент + протокол: api-функции, читалки use-project, migrateLegacyV3Journal,
  planV3Migration (+ тесты), типы протокола, устаревшие комментарии.
- **UR1.3** конформанс: снять S14-тест и импорт planV3Migration; полный server-сьют зелёный.

Фаза 2 — закрытие:
- **UR2.1** сквозной verify (сервер-тесты, GnauralCore-тесты, vue-tsc, quasar build, tsc сервера)
  + удаление forestmeditation/undo.json (UR-D1) + финальный отчёт владельцу.

## 5. Риски

- Забытый потребитель глаголов → страховка: удаление типов из протокола, vue-tsc/tsc это поймает.
- Бекенд у владельца запущен в dev (`bun --watch`) — правки server.ts перезапустят его на лету;
  краткий разрыв WS безвреден. Клиент подхватится quasar dev.
- CRLF в use-gtrack-lanes.ts — perl-проверка LF-only строк после каждой правки.
- Владелец открывает forestmeditation в окно между ответом квиза и деплоем — миграция успевает
  отработать по-старому; UR2.1 перед удалением проверяет фактическое состояние диска.

## 6. Верификация

- MindWaveCore/server: `./bun.exe test` — 0 fail (после UR1.3 — без S14-теста).
- GnauralCore: `bun test ui server` — 0 fail.
- MindWaveCore/ui: `bun run typecheck` + `bun run build` — 0 ошибок.
- Сервер-tsc: локальный ui tsc 5.7.3 + throwaway tsconfig (scratchpad) — 0 ошибок.
- Диск: в `%LOCALAPPDATA%\KKSoundCore\projects\*\` не осталось ни одного undo.json.
