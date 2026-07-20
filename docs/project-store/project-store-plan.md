# project-store — сущность «Проект»: per-file данные редактора в папке проекта (.scp.json)

**Owner request (2026-07-15):** «Накопилось много индивидуальных свойств, которые относятся к каждому
конкретному файлу - цвет кривых, волны, журнал undo и т.п. Логично было создать сущность "Проект",
который бы занимался сохранением, восстановлением, импортом и экспортом этих настроек. Наверняка в
дальнейшем появятся ещё какие-то специфические данные, которые будут важны для работы на дорожками.
Моя идея состоит в том, что для каждого открываемого файла по умолчанию в папке пользовательстких
данных, которую можно изменит в настройках редактора, создаётся директроия, в которую записываются
все относящиеся к этому данные. Файл проекта будет иметь расширение .scp.json (SoudCoreProject.json)
При возможности, пусть все файлы в этой папке остаются текстовыми, только в случае необходимости
использовать bin, например, для данных кеша. Кстати, данные кеша тоже пусть лежат в этой папке.
В плане нужно прописать полный набор функций работы с проектами, но на первом месте должна быть
разработка сервсинного класаа, API которым могут пользоваться другие подсистемы».

**Owner answers (2026-07-15, PR0.2):** «Q1 Папка userDataRoot на Windows должна находиться в
%LOCALAPPDATA%\KKSoundCore. Q2 Выносим всё из gnaural файла. Q3 OK. Q4 Кеши храним централизованно,
иначе мы про них можем не узнать в UI, если пользователь будет хранить проекты в произвольных местах.
Убираем кеш из директории-проекта. Q5 эти настройки становятся собственностью проекта. В редакторе
есть свои настройки по умолчанию, каждый проект может иметь свои настройки, которые восстанавливаются
при его открытии».

Ledger (authoritative): [project-store-progress.json](project-store-progress.json).
Методология Plan+Ledger — как в [tooltip-placement](../tooltip-placement/tooltip-placement-plan.md) /
[gtrack-editor](../gtrack-editor/gtrack-editor-plan.md): atomic per-step commits (префикс id шага),
`verify` перед `done`, пауза на owner-чекпоинтах. Правка сквозная (`MindWaveCore`, `GnauralCore`,
`SharedPasCore`) — коммитим по репозиториям раздельно, стейджим только свои файлы.

## 1. Требования владельца (дословно → нумерованно)

1. Ввести сущность **«Проект»**, отвечающую за **сохранение, восстановление, импорт и экспорт**
   индивидуальных свойств каждого конкретного файла (примеры владельца: **цвет кривых, волны,
   журнал undo** и т.п.).
2. **Расширяемость:** в дальнейшем появятся новые специфические данные, важные для работы с
   дорожками, — формат обязан принимать их без ломки существующего.
3. Для **каждого открываемого файла** по умолчанию создаётся **директория** в **папке
   пользовательских данных**; эта папка **меняется в настройках редактора**.
4. Файл проекта имеет расширение **`.scp.json`** (SoundCoreProject.json).
5. По возможности **все файлы в папке проекта — текстовые**; **bin — только при необходимости**
   (например, кеш).
6. **Данные кеша тоже лежат в папке проекта.**
7. В плане — **полный набор функций** работы с проектами, но **на первом месте — сервисный класс**:
   API, которым могут пользоваться другие подсистемы.
8. **(owner 2026-07-15, Q1)** userDataRoot на Windows — **`%LOCALAPPDATA%\KKSoundCore`** (по-прежнему
   меняется в настройках редактора, req 3).
9. **(owner 2026-07-15, Q2)** **Выносим всё из `.gnaural`-файла**: цвет/hidden/muted голосов
   переезжают в проект; сам файл этими свойствами больше не мутируем.
10. **(owner 2026-07-15, Q3)** Экспорт одним текстовым бандлом — **утверждено**.
11. **(owner 2026-07-15, Q4; пересматривает req 6)** **Кеши храним централизованно** — иначе UI может
    о них не узнать, если проекты лежат в произвольных местах. **Кеша в директории проекта нет.**
12. **(owner 2026-07-15, Q5)** Настройки волновой формы — **собственность проекта**: у редактора свои
    настройки по умолчанию, каждый проект может иметь свои, восстанавливаемые при открытии.

## 2. Что уже есть (verified 2026-07-15)

### 2.1. Идентичность файла = абсолютный путь

Единственная идентичность «текущего файла» во всей системе — строка абсолютного пути. Она — ключ
in-memory кеша расписаний (`GnauralCore/ui/stores/audio.ts:133`), per-file записей в localStorage
(`GnauralCore/ui/composables/use-gtrack-lanes.ts:120-126`), серверной истории версий `.history/`
(`GnauralCore/server/gnaural-editor-store.ts:525`) и рендер-кеша — sha1(path+size+mtime+kind)
(`MindWaveCore/server/server.ts:315-333`). Абстракции file-id/document-handle нет. Файл попадает в
редактор тремя путями, все дают абсолютный путь: дерево пресетов (`GET /api/audio/presets`),
универсальный диалог (loopback fs-browser, `GnauralCore/ui/stores/fs-browser.ts`), recent-список
(localStorage `mindwave-audio-recent-files`, cap 5, `stores/audio.ts:19-34`). Форматы:
`wav | flac | gnaural` (`SharedPasCore/ts/protocol.ts:128`).

### 2.2. Инвентаризация per-file данных (кандидаты на переезд в Проект)

| Данные | Где живут сейчас | Судьба |
|---|---|---|
| Цвет кривой голоса, hidden, muted | пишутся **в сам `.gnaural`** через `POST /api/audio/schedule/voice-state` (`protocol.ts:331`, `audio-api.ts:213`) | **req 9 (Q2)**: переезжают в секцию `voiceState` (PR2.4); редактор перестаёт писать их в файл |
| Лейны: порядок, режим, solo (+цвет/прозрачность solo-волны), fold, высоты | localStorage `mindwave-gtrack-lanes`, per-file (`use-gtrack-lanes.ts:120`) | секция `gtrackLanes` (PR2.1) |
| Per-lane оверрайды спектрограммы | localStorage `mindwave-gtrack-lane-spectrum` (`:124`) | секция `laneSpectrum` (PR2.1) |
| Исключения из микса | localStorage `mindwave-gtrack-mix-excluded` (`:126`) | секция `mixExcluded` (PR2.1) |
| Журнал undo (`GTrackModel`: undoStack/redoStack — полные JSON-снапшоты `GTrackSchedule`) | память; теряется при перезагрузке/смене файла; лимита нет (`gtrack-model.ts:207-210`) | `undo.json` проекта (PR2.2) |
| Зум/вьюпорт спектрограммы, selection, point-mode | память, эфемерно (`use-gtrack-lanes.ts:188-189`) | секция `view` (PR2.3); selection не персистим |
| Волновая форма: канальные цвета/масштаб/прозрачность/minimap | localStorage **глобально** `mindwave-audio-waveform` (`AudioPage.vue:983`) + дубль `mindwave-tracks-waveform` | **req 12 (Q5)**: секция `waveform` — переопределения поверх дефолтов редактора (PR2.3, PR-D13) |
| Пики волновой формы | пересчитываются при каждом открытии, кеша нет (`composables/audio-model.ts`) | bin-кеш **централизованно** в `tmp/` + манифест (PR6.1; req 11) |
| Версии файла (`.history/` рядом с исходником) | сервер, `gnaural-editor-store.ts:525` | не трогаем — это версии документа, не настройки |

### 2.3. Кеши сегодня

- Центральный дисковый кеш рендеров/конверсий: `MindWaveCore/server/tmp/audio-render|audio-conversion`
  + манифест `audio-cache-manifest.json`, ключ sha1(path+size+mtime+kind)
  (`MindWaveCore/server/audio-cache-manifest.ts`); управление из UI — `GnauralSettingsTab.vue`,
  `GET/DELETE /api/audio/cache`. Судьба: **остаётся центральным** (req 11); PR6.2 снят.
- Спектрограммы: только in-memory (клиентские тайлы `spectrogram-tiles.ts`, серверный refcount-кеш
  `spectrogram-audio-source.ts:114`).

### 2.4. Серверная инфраструктура, на которую опираемся

- Паттерн сервиса: `interface` + `Impl` + фабрика `createXxx`; типизированная ошибка со статусом
  (`GnauralEditorStoreError { status }`) + маппер `mapXxxError → errorResponse`; синглтон в
  `server.ts`. Архетип — `GnauralEditorStore`: per-path очередь записи `withFileLock`
  (`gnaural-editor-store.ts:702`), атомарная запись tmp+rename (`:648`), optimistic 409.
- Настройки на сервере: SQLite-таблица `app_settings(key, value_json)` (`log-db.ts:850`),
  прецедент конфигурируемой папки — `audio_presets_root` + `GET/PATCH /api/audio-settings`
  (`server.ts:1237`); generic `getAppSettingValue`/`upsertAppSetting` (`log-db.ts:896-905`).
- Протокол: `SharedPasCore/ts/protocol.ts` — пары `XxxRequest`/`XxxResponse`; сервер импортирует
  `./protocol`, UI — алиас `@protocol`. Конверт ошибок `{ error }` + HTTP-статус.
- Толерантная загрузка JSON: `AudioCacheManifest` (битый/отсутствующий файл → пустой старт).
- Тесты: co-located `<module>.test.ts`, bun:test, fixture `mkdtemp`
  (`audio-cache-manifest.test.ts:9-26`). `tsconfig` сервера компилирует также `GnauralCore/server`
  и `BodyMonitorCore/server`.
- ⚠ В `server.ts` есть NUL-байт (~стр. 331, `.update("\0")` в sha1) — ripgrep/Grep считает файл
  бинарным и молчит; искать по нему только Read/Select-String.

### 2.5. Чего нет

Понятия «папки пользовательских данных» (есть только `presetsRoot`); zip/архивных библиотек — нигде;
`schemaVersion` в существующих runtime-JSON; CI/ESLint (verify запускается только руками).

## 3. Решения

- **PR-D1 — Ядро — серверный сервис `ProjectStore` в `MindWaveCore/server/project-store.ts`.**
  Инфраструктура уровня хоста (не Gnaural-специфична), по архетипу `GnauralEditorStore`:
  `interface ProjectStore` + `ProjectStoreImpl` + `createProjectStore(...)`;
  `ProjectStoreError extends Error { status }` + `mapProjectStoreError`; синглтон в `server.ts`
  рядом с `archiveStore`/`gnauralEditorStore`. UI-клиент — `GnauralCore/ui/project-api.ts` +
  `composables/use-project.ts` (рядом с потребителями, по образцу `audio-api.ts`).
- **PR-D2 — Идентичность проекта: нормализованный абсолютный путь исходника → детерминированное имя
  папки `<slug>-<hash8>`.** slug — имя файла без расширения, санитизированное под Windows
  (запрещённые символы → `_`, обрезка ~40, нижний регистр — имя папки не должно зависеть от
  регистра, с которым пришёл путь); hash8 — первые 8 hex sha1 от
  `resolve(path).toLowerCase()` (та же нормализация, что у `withFileLock`). В `project.scp.json`
  хранится `source.path` + отпечаток (size, mtime) — для проверки статуса, показа и re-link.
  Глобального индекса нет: список проектов = скан `projects/*/project.scp.json`.
- **PR-D3 — Раскладка папки проекта (req 3-5; REVISED owner 2026-07-15, req 11).**
  ```
  <userDataRoot>/projects/<slug>-<hash8>/
    project.scp.json   — главный файл проекта (текст, pretty-JSON, req 4)
    undo.json          — журнал undo (текст; отдельный файл: большой и часто пишется)
  ```
  Кеша в папке проекта **нет** (req 11) — папка проекта состоит только из текстовых файлов, req 5
  выполняется тривиально. Имя главного файла фиксированное: расширение задаёт req 4,
  человекочитаемость несут имя папки и `source.path`; фиксированное имя устойчиво к переименованию
  исходника.
- **PR-D4 — Схема `project.scp.json`: `schemaVersion` + непрозрачные секции (req 2).**
  `{ schemaVersion: 1, kind: "SoundCoreProject", source, createdAt, updatedAt, sections: { <name>: … } }`.
  Ядро содержимого секций не знает — каждой владеет её подсистема; неизвестные секции сохраняются
  при перезаписи (совместимость вперёд). Запись атомарная (tmp+rename); чтение толерантное: битый
  файл переименовывается в `project.scp.json.broken-<ts>`, старт с пустого, событие в лог — молча
  данные не теряем.
- **PR-D5 — API-первый (req 7).** Публичный интерфейс ядра (Phase 1 целиком):
  ```ts
  openProject(sourcePath): ProjectInfo              // find-or-create + провижининг папки
  getProject(id): ProjectInfo | null
  listProjects(): ProjectInfo[]                     // скан + статус источника ok|moved|missing
  getSection(id, name): unknown | null
  putSection(id, name, value): void                 // атомарно, с коалесингом
  getUndoJournal(id) / putUndoJournal(id, journal)  // undo.json, лимиты
  deleteProject(id)
  relinkProject(id, newSourcePath)
  exportProject(id, { includeCache }) / importProject(bundle)
  ```
  Поверх — REST `/api/projects*` (конверт `{ error }`), типы `Project*` в `protocol.ts`, UI-клиент
  `project-api.ts`, composable `use-project.ts` (реактивные секции: дебаунс, flush при смене
  файла/выгрузке). Серверные подсистемы зовут `ProjectStore` напрямую (DI синглтона).
- **PR-D6 — Папка пользовательских данных: ключ `user_data_root` в `app_settings` (LOCKED owner
  2026-07-15, req 8).** Default на Windows — **`%LOCALAPPDATA%\KKSoundCore`** (fallback без
  `LOCALAPPDATA` — `~/.kksoundcore`, для не-Windows окружений разработки); проекты — в
  `<root>/projects/`. Редактируется в настройках редактора (req 3), валидация как у `presetsRoot`
  (папка существует); смена папки — с переносом проектов (PR3.2).
- **PR-D7 — Дисциплина записи.** Клиент: дебаунс ~500 мс на секцию + немедленный flush при смене
  файла/закрытии. Сервер: per-project последовательная очередь записи (аналог `withFileLock`).
  Конфликты между вкладками не детектируем: last-write-wins на уровне секции (секции мелкие — R2).
  — **Уточнение (`undo-command-log`, 2026-07-18):** `undo.json` ОСТАЁТСЯ last-write-wins (компактный лог
  целиком, KБ) — снапшоты заменены на action-лог voice-дельт (см. PR-D8). Инкрементальный append был
  рассмотрен, но несовместим с ограниченным окном undo (индексы клиент/сервер расходятся) → отложен в
  отдельный план версионности — **создан (2026-07-20):
  [undo-global-journal](../undo-global-journal/undo-global-journal-plan.md)**; версионная часть
  (append-only лог) **начата (2026-07-20):
  [undo-versioned-log](../undo-versioned-log/undo-versioned-log-plan.md)**.
- **PR-D8 — Undo-журнал (req 1).** Снапшоты `GTrackSchedule` уже JSON-сериализуемы (`signature()` =
  `JSON.stringify`) — журнал пишется в `undo.json` с лимитами (последние ~50 записей и/или ~5 МБ),
  запись отложенная (по паузе активности), восстановление при открытии файла. Ядро даёт транспорт
  get/put (PR1.3); интеграция с `GTrackModel` — PR2.2.
  — **Пересмотрено (`undo-command-log`, 2026-07-18):** снапшоты всего расписания раздували `undo.json` и
  при `keepalive:true` упирались в 64-КБ лимит браузера (`Failed to fetch`). Журнал переведён на формат
  v2 — компактный action-лог (voice-дельты транзакции + курсор), шлётся ЦЕЛИКОМ (last-write-wins, KБ), v1
  отбрасывается; keepalive убран из обычной записи (только на выгрузке). Инкрементальный append + полная
  версионность (unbounded log, компакция, checkout) — отдельный будущий план — **создан (2026-07-20):
  [undo-global-journal](../undo-global-journal/undo-global-journal-plan.md)** (глобальный журнал BK7;
  туда же перенесён вынос истории из модели и формат v3); сама версионность **начата (2026-07-20):
  [undo-versioned-log](../undo-versioned-log/undo-versioned-log-plan.md)**.
- **PR-D9 — Кеши — централизованно (ПЕРЕСМОТРЕНО owner 2026-07-15, req 11).** ~~Кеш в `cache/`
  проекта~~ — owner: кеши храним центрально (в `tmp/` + манифест), иначе UI может о них не узнать,
  когда проекты лежат в произвольных местах. У сущности «Проект» кеш-API **нет**; per-file кеши
  продолжают жить в центральном кеше с ключом от отпечатка источника (sha1(path+size+mtime+kind)).
  Кеш пиков волновой формы (PR6.1) — тоже в центральный кеш; PR6.2 (перенос рендер-кеша в проекты)
  **снят**.
- **PR-D10 — Импорт/экспорт без zip-зависимостей (LOCKED owner 2026-07-15, req 10).** Архивных
  библиотек в воркспейсе нет; экспорт — один текстовый бандл `<slug>.scpexport.json` (schemaVersion
  + project.scp.json + undo.json). Один переносимый файл, остаётся текстовым (req 5); кеш в экспорт
  не входит (кеши центральные, req 11). Импорт: валидация схемы, конфликт с существующим проектом →
  409 + явный выбор, re-link на локальный путь источника.
- **PR-D11 — Миграция существующих per-file данных (REVISED owner 2026-07-15, req 9).**
  localStorage-ключи `mindwave-gtrack-lanes`, `mindwave-gtrack-lane-spectrum`,
  `mindwave-gtrack-mix-excluded` переезжают в секции проекта с одноразовой миграцией при первом
  открытии файла; localStorage-копию сразу не удаляем (страховка переходного периода — R5).
  Данные из самого `.gnaural` (цвет/hidden/muted голосов) **выносим в секцию `voiceState`** (req 9):
  при первом открытии значения импортируются из файла в проект, дальше редактор их в файл **не
  пишет** (эндпоинт voice-state деприкейтится); mute/solo доезжают до воспроизведения и рендера
  XML-трансформом перед загрузкой (механизм `gnaural-solo-render.ts`). Старые атрибуты в уже
  существующих `.gnaural` принудительно не вычищаем — после миграции проект является источником
  истины, атрибуты файла игнорируются (R9).
- **PR-D12 — Тесты и проверка.** `project-store.test.ts` co-located, bun:test, fixture `mkdtemp`
  (по образцу `audio-cache-manifest.test.ts`). CI нет — verify каждого шага запускается руками
  (§6); поведение проверяем на живом приложении, а не только typecheck.
- **PR-D13 — Дефолты редактора + переопределения проекта (owner 2026-07-15, req 12).** Общий
  паттерн для настроек вида: у редактора — глобальные настройки по умолчанию; проект хранит в своей
  секции только собственные значения и восстанавливает их при открытии; отсутствие секции/ключа →
  действует дефолт редактора. Первый потребитель — настройки волновой формы (секция `waveform`,
  PR2.3); паттерн обязателен для будущих per-file настроек (req 2).

## 4. Шаги

### Phase 0 — план и утверждение

- [x] **PR0.1 — План + леджер (этот документ).** Verify: леджер парсится, DAG `dependsOn` ацикличен,
  план и леджер закоммичены.
- [x] **PR0.2 — PAUSE: owner утвердил план (2026-07-15).** Ответы внесены как req 8–12 и в решения:
  **Q1** → `%LOCALAPPDATA%\KKSoundCore` (PR-D6); **Q2** → выносим всё из `.gnaural` (PR-D11, шаг
  PR2.4); **Q3** → текстовый бандл утверждён (PR-D10); **Q4** → кеши центральные, кеша в папке
  проекта нет (PR-D9, PR6.2 снят); **Q5** → настройки волновой формы — собственность проекта поверх
  дефолтов редактора (PR-D13).

### Phase 1 — ядро ProjectStore: сервисный класс + API (req 7 — приоритет)

- [x] **PR1.1 — Идентичность и раскладка (PR-D2/D3).** `MindWaveCore/server/project-store.ts`:
  нормализация пути, slug+hash8, resolve папки проекта, `ProjectStoreError`; тесты (Windows-пути,
  регистр, кириллица/запрещённые символы, длинные имена). Verify: `bun test project-store`.
- [x] **PR1.2 — Хранилище scp.json (PR-D4/D7).** Атомарные load/save `project.scp.json`
  (tmp+rename), толерантное чтение + `.broken-<ts>`, сохранение неизвестных секций, per-project
  очередь записи; тесты. Verify: `bun test project-store`.
- [x] **PR1.3 — Полный API ядра (PR-D5/D8).** `openProject`/`listProjects`/`getProject`,
  `get/putSection`, `get/putUndoJournal` (лимиты), `deleteProject`, `relinkProject` (+ поиск проекта
  по сохранённому `source.path`, когда hash-папка не совпала); тесты. Verify:
  `bun test project-store`.
- [x] **PR1.4 — Протокол + REST + wiring (PR-D5/D6).** Типы `Project*` в
  `SharedPasCore/ts/protocol.ts`; маршруты `/api/projects*` в `server.ts`
  (`jsonResponse`/`errorResponse` + `mapProjectStoreError`); синглтон `createProjectStore` рядом с
  `gnauralEditorStore`; чтение ключа `user_data_root` с дефолтом `%LOCALAPPDATA%\KKSoundCore`
  (req 8). ⚠ `server.ts` не искать Grep'ом (NUL-байт). Verify: `bun test` + `bun run typecheck`
  (server).
- [x] **PR1.5 — UI-клиент и composable (PR-D5).** `GnauralCore/ui/project-api.ts` +
  `composables/use-project.ts` (загрузка секции при открытии, дебаунс put, flush при смене файла);
  вызов `openProject` из потока выбора файла (`selectPath`/`selectExternalPath`,
  `stores/audio.ts:845,877`). Verify: `bun run typecheck` + `bun run build` (MindWaveCore/ui);
  `bun test ui server` (GnauralCore); вручную — открыть `.gnaural` → появилась папка проекта с
  `project.scp.json`.
- [ ] **PR1.6 — PAUSE: owner смотрит ядро до интеграций.** Показать: созданную папку проекта,
  содержимое `project.scp.json`, интерфейс `ProjectStore`. Вопросы: имена/раскладка/секции ок?
  **Phase 2+ не начинаем до ответа.**

### Phase 2 — интеграция подсистем (req 1)

- [x] **PR2.1 — Лейны в проект (PR-D11).** Секции `gtrackLanes`/`laneSpectrum`/`mixExcluded` вместо
  per-file ключей localStorage; одноразовая миграция, localStorage-копия остаётся. Verify:
  `bun test ui server` (GnauralCore) + вручную: настройки лейнов переживают перезапуск.
- [x] **PR2.2 — Undo-журнал в проект (PR-D8).** Персист снапшотов `GTrackModel` в `undo.json`
  (лимиты), восстановление при открытии; undo переживает перезапуск. Verify: `bun test ui server`
  + вручную.
- [x] **PR2.3 — Per-file view-состояние (PR-D13, req 12).** Зум/вьюпорт спектрограммы в секцию
  `view`; канальные цвета/масштаб/прозрачность волновой формы в секцию `waveform` — переопределения
  поверх дефолтов редактора, восстанавливаются при открытии. Selection не персистим. Verify:
  `bun run typecheck`+`build` (ui) + вручную.
- [x] **PR2.4 — Voice-state из `.gnaural` в проект (PR-D11, req 9).** Секция `voiceState`
  (цвет/hidden/muted по голосам): одноразовый импорт значений из файла при первом открытии; UI
  читает/пишет проект вместо `POST /api/audio/schedule/voice-state`; mute/solo применяются к
  воспроизведению и рендеру XML-трансформом (механизм `gnaural-solo-render.ts`); исходник больше не
  мутируем. Verify: `bun test ui server` (GnauralCore) + вручную: смена цвета/mute не меняет mtime
  `.gnaural`, mute слышен при воспроизведении, после перезапуска всё на месте.
- [x] **PR2.5 — PAUSE: пройден (owner «ok», 2026-07-17).**

### Phase 3 — настройки (req 3)

- [x] **PR3.1 — Настройка `user_data_root` (PR-D6).** `GET/PATCH /api/project-settings` (по образцу
  `/api/audio-settings`), поле в настройках редактора с валидацией существования папки. Verify:
  `bun test` (server) + вручную.
- [ ] **PR3.2 — Смена папки с переносом.** Копирование `projects/` в новую папку с отчётом и
  обработкой ошибок; старую папку не удаляем автоматически. Verify: вручную, сценарий смены папки.

### Phase 4 — управление проектами

- [x] **PR4.1 — Список и статус.** `listProjects` в UI + статус источника (ok/missing — «moved»
  недетектируем без индекса, missing покрывает) + re-link. Verify: вручную (переименовать исходник
  → статус missing → re-link).
- [x] **PR4.2 — Удаление.** `deleteProject` (с защитой «только внутри `projects/`»), ручной GC
  осиротевших из списка. Verify: `bun test project-store` + вручную.
- [x] **PR4.3 — UI «Проекты».** Простая панель в настройках: список, статус, удалить / re-link /
  открыть папку. Verify: `bun run typecheck`+`build` (ui) + вручную.

### Phase 5 — импорт/экспорт (req 1)

- [x] **PR5.1 — Экспорт (PR-D10).** `exportProject` → текстовый бандл; REST + действие в UI.
  Verify: `bun test project-store` + вручную (экспорт → файл читается).
- [x] **PR5.2 — Импорт (PR-D10).** Валидация схемы, конфликты → 409 и явный выбор, re-link на
  локальный источник. Verify: `bun test project-store` + вручную (экспорт на одном пути → импорт на
  другом).

### Phase 6 — кеш (req 6 пересмотрен req 11: централизованно)

- [ ] **PR6.1 — Кеш пиков волновой формы в центральном кеше (PR-D9).** Пики считаются один раз и
  кешируются в `tmp/` через манифест (ключ от отпечатка источника), как рендеры/конверсии; видимы
  в UI управления кешем. Verify: `bun test` + вручную (повторное открытие большого файла заметно
  быстрее, после изменения файла кеш пересчитан).
- [x] ~~**PR6.2 — Центральный рендер-кеш → проекты.**~~ **СНЯТ (owner 2026-07-15, Q4/req 11):**
  кеши остаются центральными, переносить нечего.

## 5. Риски

- **R1 — Переименование/перемещение исходника осиротит проект** (имя папки — от пути).
  **Митигация:** отпечаток источника в scp.json, статус moved/missing в списке, `relinkProject`
  (PR4.1); авто-удаления нет.
- **R2 — Конкурентная запись (две вкладки).** Last-write-wins по секции + серверная очередь записи;
  секции мелкие и независимые, потеря ограничена одной секцией. Не детектируем осознанно (PR-D7).
- **R3 — Рост undo.json.** Лимиты журнала (записи/байты, PR-D8), отчёт размера в списке проектов
  (PR4.1).
  — **`undo-command-log` (2026-07-18):** action-лог снял раздувание снапшотами; журнал остаётся
  ОГРАНИЧЕННЫМ окном (~50 шагов) и шлётся целиком. Неограниченная история правок (версионность) —
  отдельный будущий план (append-only log + компакция + снапшот-якоря + checkout) — **создан
  (2026-07-20): [undo-global-journal](../undo-global-journal/undo-global-journal-plan.md)**;
  версионность **начата (2026-07-20):
  [undo-versioned-log](../undo-versioned-log/undo-versioned-log-plan.md)** (5МБ-лимит у
  undo-log отменяется, остаётся только у legacy undo.json).
- **R4 — Windows-пути:** длина (MAX_PATH), запрещённые символы, регистронезависимость, кириллица.
  **Митигация:** короткий санитизированный slug + hash8 от lowercase-пути; тесты в PR1.1.
- **R5 — Миграция из localStorage:** расхождение форматов/потеря при откате. **Митигация:**
  одноразовая миграция + localStorage-копия не удаляется в этом плане (PR-D11).
- **R6 — Битый project.scp.json** (крах при записи, ручная правка). **Митигация:** атомарная запись
  tmp+rename; толерантное чтение с бэкапом `.broken-<ts>` и логом (PR-D4).
- **R7 — Частые записи при драге.** Дебаунс на клиенте + коалесинг на сервере (PR-D7); undo пишется
  по паузе, не на каждый шаг.
- **R8 — Влияние на аудиотракт ограничено одной точкой.** Ядро хранит только метаданные
  вида/редактирования; воспроизведение/рендер читают исходник напрямую. Единственное касание
  аудиопути — применение `voiceState` (mute/solo) XML-трансформом перед загрузкой (PR2.4), тем же
  механизмом, что уже используется для solo-рендера.
- **R9 — Перенос voice-state из `.gnaural` (req 9).** Старые файлы содержат атрибуты цвета/hidden/
  muted: после одноразового импорта источник истины — проект, атрибуты файла игнорируются, но
  остаются в нём (не переписываем чужие файлы ради очистки); файл, открытый в оригинальном Gnaural,
  покажет устаревшие цвета. Mute обязан доехать до воспроизведения и рендера через трансформ —
  проверяется на слух в verify PR2.4.

## 6. Верификация (каждый шаг)

Из `MindWaveCore/server`: `bun test project-store` и `bun run typecheck`. Из `MindWaveCore/ui`:
`bun run typecheck` (vue-tsc) и `bun run build` (quasar). Из `GnauralCore`: `bun test ui server` на
шагах, трогающих его код (PR1.5, Phase 2). Ручная проверка на PAUSE: PR1.6 — папка проекта создаётся
и наполняется; PR2.5 — после перезапуска редактор восстанавливает лейны/undo/зум/voice-state.
Предпочитаем живое приложение зелёному typecheck.

## 7. Ссылки

- Архетип сервиса: [gnaural-editor-store.ts](../../../GnauralCore/server/gnaural-editor-store.ts)
  (lock, атомарная запись, typed error).
- Толерантный JSON + fixture тестов: [audio-cache-manifest.ts](../../server/audio-cache-manifest.ts),
  [audio-cache-manifest.test.ts](../../server/audio-cache-manifest.test.ts).
- Настройки: [log-db.ts](../../server/log-db.ts) (`app_settings`, `audio_presets_root`).
- Протокол: [protocol.ts](../../../SharedPasCore/ts/protocol.ts); клиенты-образцы:
  [audio-api.ts](../../../GnauralCore/ui/audio-api.ts),
  [logs-api.ts](../../ui/services/logs-api.ts).
- Потребители: [use-gtrack-lanes.ts](../../../GnauralCore/ui/composables/use-gtrack-lanes.ts),
  [gtrack-model.ts](../../../GnauralCore/ui/composables/gtrack-model.ts),
  [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue),
  [stores/audio.ts](../../../GnauralCore/ui/stores/audio.ts).
- Соседние планы: [tooltip-placement](../tooltip-placement/tooltip-placement-plan.md),
  [gtrack-editor](../gtrack-editor/gtrack-editor-plan.md).
