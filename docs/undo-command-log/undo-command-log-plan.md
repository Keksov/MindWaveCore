# undo-command-log — undo как лог действий (дельты вместо снапшотов)

Дата: 2026-07-18. Леджер: `undo-command-log-progress.json` (авторитетный статус — там).

Возникло из разбора бага при тестировании «Полосы баланса» (VB3.2): сдвиг любого узла (бит/баланс/база/
громкость) сыпал в консоль `putUndoJournal failed: Failed to fetch`. Диагноз: undo-журнал персистится
**полными снапшотами всего расписания** (до 50 undo + 50 redo), пересылается целиком на каждую правку
через `fetch(keepalive:true)`, а keepalive в браузере ограничен **64 КБ** → большой журнал не уходит.
Владелец выбрал **вариант C — настоящий лог действий**: хранить и слать не снапшоты, а атомарные
дельты.

## 1. Требования владельца (дословно)

> Почему журнал превышает 64 КБ? Я же редактирую только одну точку. Явно какая-то неэффективная схема
> undo выбрана в качестве решения. Отправляться должны только текущие атомарные действия, которые нужно
> добавлять в журнал действий.

> Я за вариант C. Настоящий лог действий

## 2. Инвентаризация (как сейчас) — всё в `GnauralCore/ui` (файлы **LF**, кроме отмеченных)

- **[gtrack-model.ts](../../GnauralCore/ui/composables/gtrack-model.ts)** — `GTrackModel`:
  - История = два массива **полных снапшотов** расписания: `undoStack: GTrackSchedule[]`,
    `redoStack: GTrackSchedule[]` (`:226-227`). В памяти дёшево (иммутабельные мутации со структурным
    шарингом: `beginEdit` хранит ссылку `:288`, `replaceVoice` переиспользует неизменённые голоса
    `:330-335`). Но при сериализации шаринг теряется → каждый снапшот = полная копия.
  - `commitEdit()` кладёт `txnBefore` в `undoStack`, чистит redo (`:292-300`); `undo/redo` (`:507-525`)
    свопают `current` со стеком.
  - Мутации: `setPointField(s)` (`:349/:357`), `movePoint` (`:378`), `movePointCrossing` — **пересортировка
    точек голоса** (`:405-432`), `insertPoint` (`:439`), `removePoint` (`:479`), `fixPreparseVoice`
    (`:498`). Все идут через `replaceVoice` и меняют **ровно один голос** (bulk — несколько, но каждый
    так же).
  - Журнал: `GTrackUndoJournal { currentSig, undo: GTrackSchedule[], redo: GTrackSchedule[] }` (`:210`),
    `isGTrackUndoJournal` (`:216`), `exportUndoJournal(max=50)` (`:530`), `adoptUndoJournal` — принимает
    только если `currentSig` совпадает с сигнатурой текущего расписания (`:541`).
- **[use-gtrack-lanes.ts](../../GnauralCore/ui/composables/use-gtrack-lanes.ts)** [CRLF] —
  `persistUndoJournal()` (`:507-514`): бюджет `UNDO_JOURNAL_BYTE_BUDGET = 4_000_000`, оценивает размер
  снапшота, режет число записей, шлёт `writeProjectUndoJournalFor(key, m.exportUndoJournal(maxEntries))`.
- **[project-api.ts](../../GnauralCore/ui/project-api.ts)** [CRLF] — `putUndoJournal` POST `/api/projects/undo`
  с `keepalive: true` (`:105-112`); `putSection` тоже keepalive (`:87-94`). `requestJson` (`:32`).
- **[use-project.ts](../../GnauralCore/ui/composables/use-project.ts)** [CRLF] — `sendUndoJournal` (`:47`)
  дебаунс `UNDO_PUT_DEBOUNCE_MS=1500`; `flushPendingProjectWrites` (`:53`) — флаш на смену файла/выгрузку.
- **[project-store.ts](../../MindWaveCore/server/project-store.ts)** — `putUndoJournal` пишет `undo.json`,
  лимит `UNDO_JOURNAL_MAX_BYTES = 5MB` → 413 (`:295, :493`).
- **[protocol.ts](../../SharedPasCore/ts/protocol.ts)** — `ProjectUndoPutRequest`/`ProjectUndoResponse`
  (тип журнала — `unknown`/структура на стороне UI).
- **Тесты**: `gtrack-model.test.ts` — поведение undo/redo (`:190-372`, публичный API) + формат журнала
  (`:418-466`, форма экспорта). `project-store.test.ts` — раунд-трип журнала + 413.

**Почему >64 КБ на одну точку:** запись истории = весь `GTrackSchedule`; `persistUndoJournal` шлёт весь
журнал (десятки записей) целиком. `keepalive:true` + тело >64 КБ → браузер режет запрос до отправки
(`TypeError: Failed to fetch`), серверный 413 недостижим.

## 3. Решения (UC-Dn)

- **UC-D1 (модель истории = лог действий).** Заменить два массива снапшотов на **один упорядоченный лог
  шагов `steps[]` + курсор `cursor`**. Шаг = дельта одной транзакции. `undo` = применить `before`,
  `cursor--`; `redo` = применить `after`, `cursor++`; новый `commit` обрезает хвост после курсора и
  добавляет шаг. Публичный API модели (`beginEdit/commitEdit/cancelEdit/edit/undo/redo/canUndo/canRedo/
  isDirty/markSaved`) **не меняется** — вызывающий код не трогаем. Мутации не меняются.
- **UC-D2 (гранулярность дельты = ГОЛОС, не точка).** Шаг хранит изменённые голоса `{ voiceId, before:
  GTrackVoice, after: GTrackVoice }[]`, вычисляется в `commitEdit` сравнением `txnBefore.voices` и
  `current.voices` **по идентичности ссылок** (структурный шаринг → у изменённых голосов новая ссылка).
  Почему не точка: `movePointCrossing` (режим по умолчанию!) пересортировывает точки, а у точек нет
  стабильного id — value-diff не отличит «точка переехала» от «много точек изменилось», минимальные
  point-операции неоднозначны и рискованны. Голос — однозначно инвертируемо, корректно для ВСЕХ мутаций
  (setFields/insert/remove/crossing/fixPreparse), и всё равно на 1–2 порядка меньше расписания (один
  голос вместо всех). Point-level — возможное будущее уточнение (нужна эмиссия команд в мутациях +
  склейка crossover).
- **UC-D3 (персистентность). ИТОГ (UC0.1→UC2.1): ВАРИАНТ A — компактный лог целиком (last-write-wins).** Формат `undo.json` v2 =
  `{ version:2, currentSig, cursor, steps }` — теперь это КБ, не МБ. Слать **весь компактный лог**
  каждый дебаунс, как и раньше (last-write-wins). Обоснование: project-store сознательно построен на
  «last-write-wins на маленькую секцию» (PR-D7); компактный лог укладывается в эту модель идеально и не
  требует нового протокола. Инкрементальный append (слать один шаг) технически «отправлять только текущее
  действие», но: (а) вводит серверный stateful лог+курсор и проблемы порядка/консистентности, чуждые
  PR-D7. → **ИТОГ: Вариант 2 (append) выбран на UC0.1, но на UC2.1 отклонён — несовместим с ограниченным окном undo (индексы клиент/сервер расходятся);
  берём Вариант A (компактный лог целиком, last-write-wins, KБ). Инкрементальный append + версионность — отдельный будущий план.**
- **UC-D4 (keepalive).** `keepalive:true` оставить ТОЛЬКО во флаше на выгрузку (`flushPendingProjectWrites`),
  убрать из обычной дебаунс-записи `putSection`/`putUndoJournal`. Это чинит `Failed to fetch` независимо.
- **UC-D5 (миграция формата).** Бамп версии `undo.json` до 2; старые снапшотные журналы (без `version` /
  v1) при загрузке **отбрасываются** (`adopt` вернёт false) — история undo best-effort на файл, конвертер
  не нужен.
- **UC-D6 (инварианты).** Сохранить guard `currentSig` в `adopt` (журнал принимается только если чейнится
  на загруженное расписание). Голоса добавлять/удалять модель не умеет (правятся только точки внутри
  голосов), поэтому применение дельты по `voiceId` корректно.

## 4. Шаги по фазам

- **Фаза 0.** `UC0.1` **PAUSE**: подтвердить UC-D1..D6, особенно UC-D3 (компактный-лог vs инкрементальный).
- **Фаза 1 — модель (чистое, тестируемое).**
  - `UC1.1` `gtrack-model.ts`: лог шагов + курсор вместо снапшот-стеков; `commitEdit` считает voice-дельту
    по идентичности ссылок; `undo/redo/canUndo/canRedo/cancelEdit` через курсор; публичный API без
    изменений. Поведенческие тесты undo/redo (`:190-372`) остаются зелёными.
  - `UC1.2` `gtrack-model.ts`: журнал v2 `{version, currentSig, cursor, steps}`; `exportUndoJournal`/
    `adoptUndoJournal`/`isGTrackUndoJournal` под v2; бюджет по шагам. Переписать тесты формата (`:418-466`).
- **Фаза 2 — персистентность.**
  - `UC2.1` `use-gtrack-lanes.ts` [CRLF]: `persistUndoJournal` под v2 (бюджет тривиален — лог компактный);
    типы. Сервер `project-store.ts` валидирует v2; `project-store.test.ts` под новый формат.
  - `UC2.2` keepalive-фикс: `project-api.ts` [CRLF] (`keepalive` опционально) + `use-project.ts` [CRLF]
    (передавать `true` только из `flushPendingProjectWrites`).
- **Фаза 3 — верификация.**
  - `UC3.1`: `bun test ui server`, `bun run typecheck`, `bun run build`.
  - `UC3.2` **PAUSE**: владелец в приложении — правит точку → 1.5с → нет ошибки в консоли; перезагрузка →
    undo/redo восстановлены; глубокая история переживает reload. Финальная приёмка.

## 5. Риски

- **R1 (корректность undo/redo).** Публичный API и семантика не меняются — поведенческие тесты `:190-372`
  это стерегут. Прогонять их после КАЖДОЙ правки Фазы 1.
- **R2 (crossover-инверсия).** Снята выбором voice-дельты (UC-D2): before/after голоса захватывают любую
  пересортировку без point-diff.
- **R3 (миграция).** v1-журналы отбрасываются (UC-D5) — приемлемо; проверить, что `adopt` не падает на
  чужом формате, а тихо возвращает false.
- **R4 (EOL).** `gtrack-model.ts` — LF; `use-gtrack-lanes/project-api/use-project` — CRLF. Проверять
  каждый файл байтовым методом (`tr -cd '\r'|wc -c`), не grep. См. память CRLF.
- **R5 (staging).** Свои файлы per-repo; не трогать `server/var/*`, `server/app.cfg`. Валидатор леджера
  перед каждым docs-коммитом.

## 6. Верификация

- `GnauralCore` — `bun test ui server` (поведение undo/redo + формат журнала + project-store).
- `MindWaveCore/ui` — `bun run typecheck` (vue-tsc) + `bun run build`.
- Реальный прогон (UC3.2): правка → нет `Failed to fetch`; reload → undo/redo работает.
- Леджер: `MindWaveCore/server/bun.exe run ../validate-ledger.js MindWaveCore/docs/undo-command-log/undo-command-log-progress.json`
