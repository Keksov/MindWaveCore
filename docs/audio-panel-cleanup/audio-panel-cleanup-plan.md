# audio-panel-cleanup — убрать вкладку плеера «Воспроизведение», старую панель «Файлы (пресеты)» и корень `presetsRoot`

**Owner request (2026-07-18):**
1. «**Новый план + леджер. Избавиться от вкладки Воспроизведение из Аудио панели**»
2. «**И добавь в план пункт Избавиться от старой вкладки Файлы (пресеты), которая сейчас находится
   левве вкладки Плеер.**» *(цитата дословная, с опечаткой источника: «левве»)*

**Owner answers (уточнения объёма, 2026-07-18):**
- Что такое «Воспроизведение» и что убирать → «**Всю вкладку main (и «Расписание»)**» (→ AC-D1).
- Насколько глубоко убирать «Файлы (пресеты)» → «**Полностью, включая store/сервер**» (→ AC-D2).
- Судьба `presetsRoot` (PAUSE Q1) → «**Убрать и presetsRoot**» → доступ к аудиофайлам
  **пере-гейтится на корни fs-browser** (→ фаза 3, AC-D2/AC-D5/AC-D6).

Ledger (authoritative): [audio-panel-cleanup-progress.json](audio-panel-cleanup-progress.json).
Методология Plan+Ledger — как в [spectrum-settings-panel](../spectrum-settings-panel/spectrum-settings-panel-plan.md) /
[menu-redesign](../menu-redesign/menu-redesign-plan.md): атомарные покомитные шаги (префикс id шага,
напр. `AC1.1 …`), `verify` перед `done`, **пауза на owner-чекпоинтах**. Код — в **GnauralCore**
(ui + server), **SharedPasCore** (protocol), **MindWaveCore** (server); докам — коммиты в MindWaveCore.
Коммитим по репозиториям раздельно, стейджим только свои файлы, избегаем рантайм-артефактов
(`server/var/`, `server/AppCore.*`, изменённый `server/app.cfg`).

---

## 1. Требования владельца (дословно → нумерованно)

1. Убрать из формы «Аудио» вкладку **«Воспроизведение»** — это внутренняя вкладка `main` плеера;
   удаляется **целиком** (обе формы: «Расписание» для .gnaural и «Воспроизведение» для wav/flac),
   плеер остаётся с единственным видом **«Треки»**.
2. Убрать **старую вкладку «Файлы (пресеты)»** — кнопку-тоггл слева от «Плеер» и её панель с деревом
   пресетов, **полностью** (UI + стор + сервер).
3. Убрать **и сам `presetsRoot`** — доступ к аудиофайлам **пере-гейтить на корни fs-browser**
   *(следствие ответа на PAUSE Q1; порождает новый чекпоинт безопасности Q2 — см. §7)*.

---

## 2. Что есть сейчас (verified 2026-07-18, всё проверено чтением кода)

Точка входа правок 1–2 — [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue). Вкладки:

| Уровень | Вкладки | Где |
|---|---|---|
| Внешние | «Плеер» / «Редактор» | [AudioPage.vue:269-270](../../../GnauralCore/ui/pages/AudioPage.vue#L269-L270) |
| Внутренние (в «Плеер») | `main` (дин. лейбл) / `tracks` («Треки») | [AudioPage.vue:291-294](../../../GnauralCore/ui/pages/AudioPage.vue#L291-L294) |

### 2.1. Вкладка `main` (объём 1) — безопасно к удалению

Премиса «Треки заменяют Расписание» **проверена**: TracksPanel рендерит расписание .gnaural как
gtrack-дорожки ([TracksPanel.vue:1356](../../../GnauralCore/ui/components/TracksPanel.vue#L1356),
[:144-145](../../../GnauralCore/ui/components/TracksPanel.vue#L144-L145)); транспорт переживает через
слот `#toolbar` ([AudioPage.vue:391-403](../../../GnauralCore/ui/pages/AudioPage.vue#L391-L403) →
[TracksPanel.vue:23](../../../GnauralCore/ui/components/TracksPanel.vue#L23)). Полный список мёртвого
кода (computeds, `scheduleViewRef`, сирота
[GnauralScheduleView.vue](../../../GnauralCore/ui/components/GnauralScheduleView.vue),
`handlePlayerKeyDown` + nav-рефы, `watch(displayMode)`) — в AC-D1 леджера. Фаза 1 **от Q1/Q2 не
зависит**.

### 2.2. Панель «Файлы (пресеты)» — фича дерева (объём 2, фаза 2)

Чисто удаляемая: сайдбар + тоггл ([AudioPage.vue:168-236](../../../GnauralCore/ui/pages/AudioPage.vue#L168-L236),
:247-259), `presetsTree`/`presetsLoading`/`refreshPresets`/`findNodeByPath`
([audio.ts](../../../GnauralCore/ui/stores/audio.ts#L776-L791)),
`fetchPresets` ([audio-api.ts:130-132](../../../GnauralCore/ui/audio-api.ts#L130-L132)), маршрут
`GET /api/audio/presets` + `listPresetTree`/`createAudioPresetsResponse` (`server.ts`),
`PresetTreeNode`/`AudioPresetsResponse` ([protocol.ts:204-215](../../../SharedPasCore/ts/protocol.ts#L204-L215)),
i18n. `selectPath` переписывается на вывод `fileKind` из расширения (AC-D3); тип `selectedNode` —
на локальный минимальный (AC-D4). **В фазе 2 `presetsRoot` ещё жив.**

### 2.3. `presetsRoot` и пере-гейт (объём 3, фаза 3) — с картой и оговоркой безопасности

`presetsRoot` несёт **три** роли, не связанные с деревом:
- security allow-list **доступа ко ВСЕМ аудиофайлам** — `resolveAllowedAudioFilePath`
  ([audio-file-utils.ts:67-101](../../../GnauralCore/server/audio-file-utils.ts#L67-L101));
- **сид диалога открытия** — `fileDialogInitialPath`
  ([AudioPage.vue:616-619](../../../GnauralCore/ui/pages/AudioPage.vue#L616-L619));
- корень **истории редактора** — `gnaural-editor-store.ts:508,517-527`.

**Карта пере-гейта (проверено):** `resolveAllowedAudioFilePath` **уже мульти-рутовый** (сливает
`presetsRoot` + `aExtraRoots`), но корни fs-browser **нигде не заведены** как аудио-корни — сегодня
`aExtraRoots` несут лишь эфемерные temp-каталоги (alpha/sleep/replay). Единый источник корней
fs-browser — `createLocalFsProvider().listRoots()`
(`MindWaveCore/server/fs-browser-local.ts:149-164`; `async`, `FsRoot[]` с `.path`; отдаётся
`GET /fs/roots` на loopback-сервере). **5 вызывателей** `resolveAllowedAudioFilePath`:
`gnaural-editor-store.ts:508`, `gnaural-session.ts:333` (play), `ui-ws-handler.ts:42` (спектрограмма),
`server.ts:1723` (`/api/audio/file`), `server.ts:1780` (`/api/audio/schedule`).

**⚠ Безопасность (AC-D6, PAUSE Q2).** Корни fs-browser — это **вся машина** (все диски + домашние
папки; `fs-browser-local.ts:1-5,64-78,125-164` — «full-machine read is intentional; safety = 127.0.0.1
bind, not a path sandbox»). Главный сервер слушает `Bun.serve({ port })` **без hostname**
(`server.ts:2273-2274`) → дефолт `0.0.0.0` = **LAN-facing**. **FB-D2** (`server.ts:2266-2268`)
**намеренно** вынес доступ-ко-всей-машине на **отдельный loopback-only** сервер. Пере-гейт
LAN-facing `/api/audio/file` и `/api/audio/schedule` на корни fs-browser **развернёт границу FB-D2**:
любой клиент в LAN сможет читать любой аудиофайл на машине. → §7 Q2.

### 2.4. Две разные «пресеты» (R6)

Спектрограммные «пресеты» (`stores/spectrogram.ts`, `SpectrogramPresetsDialog.vue`, i18n
`audio.spectrogramPreset*`) — **другая** фича, делящая слово. **Не трогаем.**

---

## 3. Решения (полные тексты — в леджере)

- **AC-D1** — «Воспроизведение» = вкладка `main`; удаляется целиком, плеер = только «Треки».
- **AC-D2** *(REVISED)* — `presetsRoot` удаляется **целиком**, доступ пере-гейтится на корни
  fs-browser. Объём разбит: фаза 2 — фича дерева; фаза 3 — `presetsRoot` + пере-гейт.
- **AC-D3** — `selectPath` → `fileKind` из расширения.
- **AC-D4** — `selectedNode` → локальный `SelectedAudioFile`.
- **AC-D5** *(REVISED)* — весь обвес `presetsRoot` (AudioSettings.presetsRoot, БД `audio_presets_root`,
  GET/PATCH `/api/audio-settings`, `saveSettings`/`loadSettings`, `settings.audio*`) уходит в фазе 3.
- **AC-D6** *(NEW, ЗАКРЫТ Q2=b)* — чекпоинт безопасности (вся машина × LAN × FB-D2); решение:
  пере-гейт на корни fs-browser + **loopback-ограничение** аудио-эндпоинтов (шаг AC3.2).

---

## 4. Фазы и шаги

- **Фаза 0** — `AC0.1`: план+леджер+инвентаризация. Q1 отвечен (убрать presetsRoot). **PAUSE Q2**.
- **Фаза 1 — вкладка `main`** (GnauralCore ui; от Q1/Q2 не зависит):
  `AC1.1` шаблон · `AC1.2` script + сирота GnauralScheduleView.vue · `AC1.3` i18n + CSS.
- **Фаза 2 — фича дерева «Файлы (пресеты)»** (мульти-репо; `presetsRoot` ещё жив):
  `AC2.1` UI · `AC2.2` стор (+AC-D3/AC-D4) · `AC2.3` audio-api · `AC2.4` сервер (дерево) ·
  `AC2.5` протокол (`PresetTreeNode`/`AudioPresetsResponse`) · `AC2.6` i18n.
- **Фаза 3 — `presetsRoot` + пере-гейт** (Q2=b — с loopback-гейтом):
  `AC3.1` пере-гейт **корней** доступа на fs-browser (4 точки) · `AC3.2` **loopback-гейт**
  аудио-эндпоинтов (/api/audio/file, /schedule, спектрограмма) · `AC3.3` история редактора
  (контейнмент по любому корню) · `AC3.4` снять обвес `presetsRoot` · `AC3.5` судьба `AudioSettings`.

Граф зависимостей — в леджере (`dependsOn`), проверен валидатором на ацикличность.

---

## 5. Риски

- **R1 — `server.ts`: UTF-8 со случайным NUL-байтом** (~offset 10862), из-за которого ripgrep считает
  файл бинарным (grep нужен `--text`). Это **НЕ** UTF-16 (ранняя заметка исправлена). Правки штатным
  `Edit`; кодировку сохранять, лишних NUL не плодить (память [CRLF vs scripted edits]).
- **R2 — безопасность пере-гейта (AC-D6, решено Q2=b).** Корни fs-browser = вся машина; главный
  сервер LAN-facing; FB-D2 держал это на loopback. Митигация: шаг AC3.2 ограничивает
  `/api/audio/file`, `/api/audio/schedule` и спектрограмму loopback-ом (как сам fs-browser),
  сохраняя границу FB-D2.
- **R3 — не «переудалить».** `presetsRoot` жив всю фазу 2; удаляется только в фазе 3 после пере-гейта,
  иначе доступ к аудио падает в середине. Спектрограммные пресеты не трогать (R6).
- **R4 — нет CI/ESLint/тестов** (AGENTS.md): перед удалением общих символов (`PresetTreeNode`,
  `AudioSettings`, i18n-ключи) — **grep на 0 ссылок**; гонять реальное приложение.
- **R5 — `protocol.ts` — единый источник**, реэкспортится обоими серверами: типы удалять **последними**,
  топо-порядком.
- **R6 — мульти-репо коммиты** (GnauralCore ui+server, SharedPasCore, MindWaveCore server+docs):
  раздельно по репам, стейджить только свои файлы (память [Multi-repo commit structure]).

---

## 6. Verify

- **GnauralCore** — `bun test ui server`; точечно `bun run typecheck` + `bun run build` в
  `MindWaveCore/ui`.
- **Гонять реальное приложение** (перед `done`):
  - Плеер = только «Треки», под-вкладок нет; слева от «Плеер» нет «Файлы».
  - .gnaural → gtrack-дорожки + транспорт; wav через Меню→Файл→Открыть → Треки показывает спектр;
    недавние файлы выбираются и играют.
  - После фазы 3: воспроизведение/спектрограмма/скачивание из корней fs-browser работают; путь вне
    разрешённых корней → отказ; по варианту Q2(b) — `/api/audio/file` и `/schedule` недостижимы с
    не-loopback адреса; правка .gnaural сохраняется, `.history` рядом.

---

## 7. Открытые вопросы — ВСЕ ЗАКРЫТЫ 2026-07-18

**Q1 (AC-D2) — ЗАКРЫТ:** «Убрать и presetsRoot» → добавлена фаза 3 (пере-гейт на корни fs-browser).

**Q2 (AC-D6) — ЗАКРЫТ, вариант (b):** пере-гейт на корни fs-browser **+ одновременно** ограничить
`/api/audio/file`, `/api/audio/schedule` и спектрограмму **loopback-ом** (как сам fs-browser), чтобы
не открывать всю машину в LAN и сохранить границу FB-D2 (шаг AC3.2). Отклонены: (a) вся машина как
есть — открыла бы чтение любого аудиофайла машины клиентам LAN; (c) один настраиваемый аудио-корень —
оставлял бы `presetsRoot`-подобный механизм вопреки «убрать presetsRoot». Реализационные заметки
(где брать `requestIP`; серверный play не гейтить; LAN-клиент теряет проигрывание локальных файлов —
ожидаемо) — в AC-D6/AC3.2 леджера.

*Оба owner-чекпоинта закрыты — план готов к исполнению по фазам. Фазы 1–2 от Q2 не зависели.*
