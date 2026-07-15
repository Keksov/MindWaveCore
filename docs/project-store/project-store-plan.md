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
| Цвет кривой голоса, hidden, muted | пишутся **в сам `.gnaural`** через `POST /api/audio/schedule/voice-state` (`protocol.ts:331`, `audio-api.ts:213`) | **Q2**: пока остаются в `.gnaural`; проект не дублирует |
| Лейны: порядок, режим, solo (+цвет/прозрачность solo-волны), fold, высоты | localStorage `mindwave-gtrack-lanes`, per-file (`use-gtrack-lanes.ts:120`) | секция `gtrackLanes` (PR2.1) |
| Per-lane оверрайды спектрограммы | localStorage `mindwave-gtrack-lane-spectrum` (`:124`) | секция `laneSpectrum` (PR2.1) |
| Исключения из микса | localStorage `mindwave-gtrack-mix-excluded` (`:126`) | секция `mixExcluded` (PR2.1) |
| Журнал undo (`GTrackModel`: undoStack/redoStack — полные JSON-снапшоты `GTrackSchedule`) | память; теряется при перезагрузке/смене файла; лимита нет (`gtrack-model.ts:207-210`) | `undo.json` проекта (PR2.2) |
| Зум/вьюпорт спектрограммы, selection, point-mode | память, эфемерно (`use-gtrack-lanes.ts:188-189`) | секция `view` (PR2.3); selection не персистим |
| Волновая форма: канальные цвета/масштаб/прозрачность/minimap | localStorage **глобально** `mindwave-audio-waveform` (`AudioPage.vue:983`) + дубль `mindwave-tracks-waveform` | **Q5**: per-file секция `waveform` (PR2.3) |
| Пики волновой формы | пересчитываются при каждом открытии, кеша нет (`composables/audio-model.ts`) | bin-кеш в `cache/` проекта (PR6.1) |
| Версии файла (`.history/` рядом с исходником) | сервер, `gnaural-editor-store.ts:525` | не трогаем — это версии документа, не настройки |

### 2.3. Кеши сегодня

- Центральный дисковый кеш рендеров/конверсий: `MindWaveCore/server/tmp/audio-render|audio-conversion`
  + манифест `audio-cache-manifest.json`, ключ sha1(path+size+mtime+kind)
  (`MindWaveCore/server/audio-cache-manifest.ts`); управление из UI — `GnauralSettingsTab.vue`,
  `GET/DELETE /api/audio/cache`. Судьба — PR6.2 (**Q4**).
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
  (запрещённые символы → `_`, обрезка ~40); hash8 — первые 8 hex sha1 от
  `resolve(path).toLowerCase()` (та же нормализация, что у `withFileLock`). В `project.scp.json`
  хранится `source.path` + отпечаток (size, mtime) — для проверки статуса, показа и re-link.
  Глобального индекса нет: список проектов = скан `projects/*/project.scp.json`.
- **PR-D3 — Раскладка папки проекта (req 3-6).**
  ```
  <userDataRoot>/projects/<slug>-<hash8>/
    project.scp.json   — главный файл проекта (текст, pretty-JSON, req 4)
    undo.json          — журнал undo (текст; отдельный файл: большой и часто пишется)
    cache/             — кеш проекта; bin допустим ТОЛЬКО здесь (req 5, 6)
  ```
  Имя главного файла фиксированное: расширение задаёт req 4, человекочитаемость несут имя папки и
  `source.path`; фиксированное имя устойчиво к переименованию исходника.
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
  cacheFilePath(id, key) / readCacheFile / writeCacheFile / clearCache(id)   // bin допустим
  deleteProject(id)
  relinkProject(id, newSourcePath)
  exportProject(id, { includeCache }) / importProject(bundle)
  ```
  Поверх — REST `/api/projects*` (конверт `{ error }`), типы `Project*` в `protocol.ts`, UI-клиент
  `project-api.ts`, composable `use-project.ts` (реактивные секции: дебаунс, flush при смене
  файла/выгрузке). Серверные подсистемы зовут `ProjectStore` напрямую (DI синглтона).
- **PR-D6 — Папка пользовательских данных: ключ `user_data_root` в `app_settings`.** Default —
  `<serverDir>/var/userdata` (внутри уже-gitignored `var/`); проекты — в `<root>/projects/`.
  Редактируется в настройках редактора (req 3), валидация как у `presetsRoot` (папка существует);
  смена папки — с переносом проектов (PR3.2). **Q1** владельцу: дефолт `var/userdata` или
  `Documents\MindWave`?
- **PR-D7 — Дисциплина записи.** Клиент: дебаунс ~500 мс на секцию + немедленный flush при смене
  файла/закрытии. Сервер: per-project последовательная очередь записи (аналог `withFileLock`).
  Конфликты между вкладками не детектируем: last-write-wins на уровне секции (секции мелкие — R2).
- **PR-D8 — Undo-журнал (req 1).** Снапшоты `GTrackSchedule` уже JSON-сериализуемы (`signature()` =
  `JSON.stringify`) — журнал пишется в `undo.json` с лимитами (последние ~50 записей и/или ~5 МБ),
  запись отложенная (по паузе активности), восстановление при открытии файла. Ядро даёт транспорт
  get/put (PR1.3); интеграция с `GTrackModel` — PR2.2.
- **PR-D9 — Кеш проекта (req 5, 6).** Новые per-file кеши — в `cache/` проекта, bin допустим;
  инвалидация по отпечатку источника (size+mtime — как в ключах существующего манифеста). Первый
  реальный потребитель — кеш пиков волновой формы (PR6.1; сейчас пики считаются при каждом
  открытии). Существующий центральный кеш рендеров переносится отдельным шагом PR6.2 **после** ядра,
  чтобы не смешивать с приоритетом req 7; порядок подтвердить (**Q4**).
- **PR-D10 — Импорт/экспорт без zip-зависимостей.** Архивных библиотек в воркспейсе нет; экспорт —
  один текстовый бандл `<slug>.scpexport.json` (schemaVersion + project.scp.json + undo.json;
  `cache/` по умолчанию исключён, при `includeCache` — base64). Один переносимый файл, остаётся
  текстовым (req 5). Импорт: валидация схемы, конфликт с существующим проектом → 409 + явный выбор,
  re-link на локальный путь источника. **Q3**: такой бандл vs zip.
- **PR-D11 — Миграция существующего per-file localStorage.** `mindwave-gtrack-lanes`,
  `mindwave-gtrack-lane-spectrum`, `mindwave-gtrack-mix-excluded` переезжают в секции проекта с
  одноразовой миграцией при первом открытии файла; localStorage-копию сразу не удаляем (страховка
  переходного периода — R5). Данные, живущие в самом `.gnaural` (цвет/hidden/muted голосов), проект
  **не дублирует**; их возможный перенос — **Q2** (рекомендация: пока оставить как есть — сейчас
  смена цвета перезаписывает исходный файл, и это отдельное осознанное решение владельца).
- **PR-D12 — Тесты и проверка.** `project-store.test.ts` co-located, bun:test, fixture `mkdtemp`
  (по образцу `audio-cache-manifest.test.ts`). CI нет — verify каждого шага запускается руками
  (§6); поведение проверяем на живом приложении, а не только typecheck.

## 4. Шаги

### Phase 0 — план и утверждение

- [x] **PR0.1 — План + леджер (этот документ).** Verify: леджер парсится, DAG `dependsOn` ацикличен,
  план и леджер закоммичены.
- [ ] **PR0.2 — PAUSE: owner утверждает PR-D1..D12 и отвечает на вопросы.**
  **Q1** — дефолт папки данных: `server/var/userdata` (рекомендую) или `Documents\MindWave`?
  **Q2** — цвет/hidden/muted голосов: оставить в `.gnaural` (рекомендую пока) или перенести в проект,
  чтобы вид не переписывал исходник?
  **Q3** — формат экспорта: один текстовый `.scpexport.json` (рекомендую, без новых зависимостей)
  или zip?
  **Q4** — центральный кеш рендеров WAV: переносить в папки проектов шагом PR6.2 после ядра
  (рекомендую), раньше, или оставить центральным?
  **Q5** — «волны» из req 1: делаем канальные цвета/масштаб волновой формы per-file (сейчас они
  глобальные) в дополнение к кешу пиков?
  **Реализацию (Phase 1+) не начинаем до ответа.**

### Phase 1 — ядро ProjectStore: сервисный класс + API (req 7 — приоритет)

- [ ] **PR1.1 — Идентичность и раскладка (PR-D2/D3).** `MindWaveCore/server/project-store.ts`:
  нормализация пути, slug+hash8, resolve папки проекта, `ProjectStoreError`; тесты (Windows-пути,
  регистр, кириллица/запрещённые символы, длинные имена). Verify: `bun test project-store`.
- [ ] **PR1.2 — Хранилище scp.json (PR-D4/D7).** Атомарные load/save `project.scp.json`
  (tmp+rename), толерантное чтение + `.broken-<ts>`, сохранение неизвестных секций, per-project
  очередь записи; тесты. Verify: `bun test project-store`.
- [ ] **PR1.3 — Полный API ядра (PR-D5/D8/D9).** `openProject`/`listProjects`/`getProject`,
  `get/putSection`, `get/putUndoJournal` (лимиты), cache-API (пути/чтение/запись/clear; bin только
  в `cache/`), `deleteProject`, `relinkProject`; тесты. Verify: `bun test project-store`.
- [ ] **PR1.4 — Протокол + REST + wiring (PR-D5/D6).** Типы `Project*` в
  `SharedPasCore/ts/protocol.ts`; маршруты `/api/projects*` в `server.ts`
  (`jsonResponse`/`errorResponse` + `mapProjectStoreError`); синглтон `createProjectStore` рядом с
  `gnauralEditorStore`; чтение ключа `user_data_root` с дефолтом. ⚠ `server.ts` не искать Grep'ом
  (NUL-байт). Verify: `bun test` + `bun run typecheck` (server).
- [ ] **PR1.5 — UI-клиент и composable (PR-D5).** `GnauralCore/ui/project-api.ts` +
  `composables/use-project.ts` (загрузка секции при открытии, дебаунс put, flush при смене файла);
  вызов `openProject` из потока выбора файла (`selectPath`/`selectExternalPath`,
  `stores/audio.ts:845,877`). Verify: `bun run typecheck` + `bun run build` (MindWaveCore/ui);
  `bun test ui server` (GnauralCore); вручную — открыть `.gnaural` → появилась папка проекта с
  `project.scp.json`.
- [ ] **PR1.6 — PAUSE: owner смотрит ядро до интеграций.** Показать: созданную папку проекта,
  содержимое `project.scp.json`, интерфейс `ProjectStore`. Вопросы: имена/раскладка/секции ок?
  **Phase 2+ не начинаем до ответа.**

### Phase 2 — интеграция подсистем (req 1)

- [ ] **PR2.1 — Лейны в проект (PR-D11).** Секции `gtrackLanes`/`laneSpectrum`/`mixExcluded` вместо
  per-file ключей localStorage; одноразовая миграция, localStorage-копия остаётся. Verify:
  `bun test ui server` (GnauralCore) + вручную: настройки лейнов переживают перезапуск.
- [ ] **PR2.2 — Undo-журнал в проект (PR-D8).** Персист снапшотов `GTrackModel` в `undo.json`
  (лимиты), восстановление при открытии; undo переживает перезапуск. Verify: `bun test ui server`
  + вручную.
- [ ] **PR2.3 — Per-file view-состояние.** Зум/вьюпорт спектрограммы в секцию `view`; по ответу на
  Q5 — канальные цвета/масштаб/прозрачность волновой формы в секцию `waveform`. Selection не
  персистим. Verify: `bun run typecheck`+`build` (ui) + вручную.
- [ ] **PR2.4 — PAUSE: owner проверяет «редактор всё вспоминает» после перезапуска.**

### Phase 3 — настройки (req 3)

- [ ] **PR3.1 — Настройка `user_data_root` (PR-D6).** `GET/PATCH /api/project-settings` (по образцу
  `/api/audio-settings`), поле в настройках редактора с валидацией существования папки. Verify:
  `bun test` (server) + вручную.
- [ ] **PR3.2 — Смена папки с переносом.** Копирование `projects/` в новую папку с отчётом и
  обработкой ошибок; старую папку не удаляем автоматически. Verify: вручную, сценарий смены папки.

### Phase 4 — управление проектами

- [ ] **PR4.1 — Список и статус.** `listProjects` в UI + статус источника (ok/moved/missing) +
  re-link. Verify: вручную (переименовать исходник → статус moved → re-link).
- [ ] **PR4.2 — Удаление и очистка.** `deleteProject`, `clearCache`, ручной GC осиротевших из
  списка. Verify: `bun test project-store` + вручную.
- [ ] **PR4.3 — UI «Проекты».** Простая панель в настройках: список, статус, удалить / очистить кеш
  / re-link / открыть папку. Verify: `bun run typecheck`+`build` (ui) + вручную.

### Phase 5 — импорт/экспорт (req 1)

- [ ] **PR5.1 — Экспорт (PR-D10).** `exportProject` → текстовый бандл; REST + действие в UI.
  Verify: `bun test project-store` + вручную (экспорт → файл читается).
- [ ] **PR5.2 — Импорт (PR-D10).** Валидация схемы, конфликты → 409 и явный выбор, re-link на
  локальный источник. Verify: `bun test project-store` + вручную (экспорт на одном пути → импорт на
  другом).

### Phase 6 — кеш (req 6)

- [ ] **PR6.1 — Кеш пиков волновой формы (PR-D9).** Первый bin-потребитель `cache/`: пики
  считаются один раз, инвалидация по отпечатку источника. Verify: `bun test` + вручную (повторное
  открытие большого файла заметно быстрее, после изменения файла кеш пересчитан).
- [ ] **PR6.2 — Центральный рендер-кеш → проекты (Q4).** Перенос `tmp/audio-render|audio-conversion`
  в `cache/` проектов (или решение владельца оставить центральным); правка `GnauralSettingsTab` и
  манифеста. Verify: `bun test` + вручную (рендер/конверсия работают, кеш попадает в папку проекта).

## 5. Риски

- **R1 — Переименование/перемещение исходника осиротит проект** (имя папки — от пути).
  **Митигация:** отпечаток источника в scp.json, статус moved/missing в списке, `relinkProject`
  (PR4.1); авто-удаления нет.
- **R2 — Конкурентная запись (две вкладки).** Last-write-wins по секции + серверная очередь записи;
  секции мелкие и независимые, потеря ограничена одной секцией. Не детектируем осознанно (PR-D7).
- **R3 — Рост undo.json и кеша.** Лимиты журнала (записи/байты, PR-D8), `clearCache`, отчёт размера
  в списке проектов (PR4.1).
- **R4 — Windows-пути:** длина (MAX_PATH), запрещённые символы, регистронезависимость, кириллица.
  **Митигация:** короткий санитизированный slug + hash8 от lowercase-пути; тесты в PR1.1.
- **R5 — Миграция из localStorage:** расхождение форматов/потеря при откате. **Митигация:**
  одноразовая миграция + localStorage-копия не удаляется в этом плане (PR-D11).
- **R6 — Битый project.scp.json** (крах при записи, ручная правка). **Митигация:** атомарная запись
  tmp+rename; толерантное чтение с бэкапом `.broken-<ts>` и логом (PR-D4).
- **R7 — Частые записи при драге.** Дебаунс на клиенте + коалесинг на сервере (PR-D7); undo пишется
  по паузе, не на каждый шаг.
- **R8 — Проект не должен влиять на аудиотракт.** Ядро хранит только метаданные вида/редактирования;
  воспроизведение/рендер продолжают читать исходник напрямую; никаких правок аудиопути в этом плане.

## 6. Верификация (каждый шаг)

Из `MindWaveCore/server`: `bun test project-store` и `bun run typecheck`. Из `MindWaveCore/ui`:
`bun run typecheck` (vue-tsc) и `bun run build` (quasar). Из `GnauralCore`: `bun test ui server` на
шагах, трогающих его код (PR1.5, Phase 2). Ручная проверка на PAUSE: PR1.6 — папка проекта создаётся
и наполняется; PR2.4 — после перезапуска редактор восстанавливает лейны/undo/зум. Предпочитаем живое
приложение зелёному typecheck.

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
