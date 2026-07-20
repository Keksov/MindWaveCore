# access-preset-root — loopback-only bind + модель доступа «по умолчанию без ограничений, presetRoot сужает»

**Owner request (2026-07-20):**

1. **«Если у нас уже есть механизм ограничения записи, то не будем его удалять, возможно он когда-то пригодится.»**
2. **«По умолчанию bun должен слушать только 127.0.0.1/localhost и разрешать запись любых файлов. Пусть операционная система следит за правами досутпа.»** *(цитата дословная, с опечаткой источника: «досутпа»).*
3. **«Если задан presetRoot, то ограничиваем доступ только к этой папке.»**

**Owner answers (уточнения объёма, 2026-07-20):**

- Bind — **только 127.0.0.1**, LAN-доступ к UI убираем (разворот AC-D6). *(→ AR-D1)*
- presetRoot — **завести сейчас** (полная модель: дефолт без ограничений, presetRoot сужает). *(→ AR-D3)*

Ledger (authoritative): [access-preset-root-progress.json](access-preset-root-progress.json).

Методология — Plan + Ledger (как в [audio-panel-cleanup](../audio-panel-cleanup/audio-panel-cleanup-plan.md), [wave-spectrum-cache](../wave-spectrum-cache/wave-spectrum-cache-plan.md)): атомарные покоммитные шаги `AR1.1 …`, `verify` перед `done`, **на PAUSE — стоп и вопрос владельцу**. Затрагивает `MindWaveCore/server` (bind, presetRoot-настройка, резолвер корней, аудио-эндпоинты), `GnauralCore/server` (`resolveAllowedAudioFilePath`, редактор), UI (поле настройки), возможно `SharedPasCore/ts` (тип настройки).

Контекст: фича возникла из бага сохранения (403 «History directory would be created outside the allowed roots»); корневой фикс `isPathInsideBase` для корней-дисков уже сделан отдельным коммитом (`67fe25d`) и разблокировал сохранение — эта фича задаёт целевую модель доступа поверх.

---

## 1. Требования владельца (дословно → нумерованно)

1. Механизм ограничения доступа/записи **не удалять** — оставить в коде для будущего.
2. По умолчанию: сервер слушает **только 127.0.0.1**; чтение/запись **любых** файлов разрешены (права — забота ОС).
3. Если задан **presetRoot** — доступ (чтение/запись аудио + редактор + история) ограничивается этой папкой.

---

## 2. Что есть сейчас (verified 2026-07-20, чтением кода + рантайм-проверкой)

### 2.1. Bind

Главный `Bun.serve({ port: getPort() })` — **без `hostname`** ([server.ts:2159-2161](../../server/server.ts#L2159-L2161)) → дефолт Bun = `0.0.0.0` (LAN-facing). Это сделано намеренно (AC-D6/FB-D2/AC3.2): LAN-клиент может открыть UI, а чувствительные файловые эндпоинты (`/api/audio/file`, `/api/audio/schedule`, спектрограмма) ограничены loopback-ом per-request по IP; браузер файлов — на отдельном 127.0.0.1-сервере.

### 2.2. Модель доступа

- `presetRoot` **удалён целиком** (audio-panel-cleanup AC3.4/AC3.5): DB-настройка `audio_presets_root`, `AudioSettings.presetsRoot`, маршрут `/api/audio-settings`, i18n — всё снято. 0 ссылок в коде.
- Единственный allow-list сегодня — `resolveAllowedAudioFilePath` ([audio-file-utils.ts:61-90](../../../GnauralCore/server/audio-file-utils.ts#L61-L90)): мульти-рутовый; **пустой список корней → `null` = запрет всего**.
- Корни поставляет `getAudioAccessRoots()` ([server.ts:91-93](../../server/server.ts#L91-L93)) = `createLocalFsProvider().listRoots().map(.path)` = **вся машина** (диски + известные папки), но с контейнментом (сетевые/непереч. пути блокируются).
- 5 вызывателей `resolveAllowedAudioFilePath`: редактор ([gnaural-editor-store.ts:510](../../../GnauralCore/server/gnaural-editor-store.ts#L510)), play ([gnaural-session.ts:333](../../../GnauralCore/server/gnaural-session.ts#L333)), спектрограмма ([ui-ws-handler.ts:54](../../server/ui-ws-handler.ts#L54)), `/api/audio/file`, `/api/audio/schedule` ([server.ts](../../server/server.ts)).

### 2.3. Настройки

Прецедент — `userDataRoot`: живёт в project-settings (log-db app settings), читается `archiveStore.getProjectSettings()`, пишется `updateProjectSettings()`, API `/api/project-settings` (GET/PATCH). UI — [GnauralSettingsTab.vue](../../../GnauralCore/ui/settings/GnauralSettingsTab.vue). `AudioSettings`/`/api/audio-settings` были удалены — **presetRoot переиспользует project-settings** (память reuse-standard-forms).

---

## 3. Решения (полные тексты — в леджере)

- **AR-D1** — главный сервер биндится на `127.0.0.1` *(владелец)*. Следствие: LAN-доступ к UI/эндпоинтам исчезает (разворот AC-D6). Per-endpoint loopback-гейты (AC3.2) становятся избыточны, но **оставляем** (defense-in-depth, не churn'им). Риск устройств — R1.
- **AR-D2** — резолвер получает явный режим: **unrestricted** (разрешён любой resolved-путь) vs **restricted to [presetRoot]**. Убрать ловушку «пустой список → запрет»: unrestricted — отдельный режим, не пустой список. Механизм ограничения сохранён (требование 1).
- **AR-D3** — `presetRoot` заводится заново как **project-setting** (рядом с `userDataRoot`), API `/api/project-settings`, поле в Settings UI. Пусто ⇒ unrestricted; непусто ⇒ restrict.
- **AR-D4** — редактор/история и play/спектр/HTTP-эндпоинты используют один источник режима (`getAudioAccessRoots` → presetRoot-или-unrestricted), так что EH-гейт истории и все 5 точек ведут себя согласованно.

---

## 4. Фазы и шаги

**Фаза 0** — `AR0.1` план+леджер + инвентаризация.

**Фаза 1 — loopback bind**: `AR1.1` `hostname: "127.0.0.1"` в главный `Bun.serve` · **`AR1.2` PAUSE** — владелец проверяет: локальное приложение (AppCore) и устройства BodyMonitor работают, LAN-доступ пропал.

**Фаза 2 — модель доступа**: `AR2.1` `resolveAllowedAudioFilePath` + резолвер поддерживают режим unrestricted (без ловушки пустого списка) · `AR2.2` `getAudioAccessRoots` → `[presetRoot]` если задан, иначе unrestricted; прокинуть во все 5 точек · `AR2.3` согласовать редактор/историю (координация с незакоммиченным `gnaural-editor-store.ts` владельца).

**Фаза 3 — конфиг presetRoot**: `AR3.1` presetRoot в project-settings (log-db) + `/api/project-settings` · `AR3.2` поле в Settings UI · **`AR3.3` PAUSE** — владелец: пусто ⇒ пишу/читаю где угодно; задан presetRoot ⇒ доступ только внутри него.

---

## 5. Риски

- **R1 — устройства/LAN.** Bind loopback уберёт LAN-доступ; проверить, что EEG/BodyMonitor подключаются через локальный `BodyMonitor.exe` (localhost), а не к главному серверу по LAN (иначе сломается). Проверка — на PAUSE `AR1.2`.
- **R2 — «unrestricted» ≠ пустой список.** Сейчас пустые корни = запрет; нельзя случайно оставить путь, где unrestricted превратится в «запретить всё». Явный режим/сентинел + тест.
- **R3 — незакоммиченный файл владельца.** `gnaural-editor-store.ts` в активной правке (EH2.1) — стейджу только свои файлы, изменения редактора согласую (память [multi-repo-commit-structure]).
- **R4 — безопасность.** «Запись куда угодно» безопасна только при loopback-бинде; порядок фаз (bind → unrestricted) это гарантирует. Если владелец в AR1.2 решит оставить LAN — unrestricted-дефолт пересмотреть.
- **R5 — CRLF/NUL в server.ts** (память [crlf-scripted-edits], [server-ts-nul-byte-ripgrep]); кросс-репо серверные правки проверять полным рестартом AppCore (память [bun-watch-ignores-cross-repo-server]).

---

## 6. Verify

- `GnauralCore` — `bun test server` (резолвер unrestricted/restricted; корни-диски уже покрыты `audio-file-utils.test.ts`).
- `MindWaveCore/ui` — `bun run typecheck` + `bun run build`; серверный tsc — ui tsc 5.7.3 + throwaway (память [server-typecheck-bunx-tsc-drift]).
- `validate-ledger.js` перед каждым docs-коммитом.
- **Гонять реальное приложение**: (1) после AR1.1 — локально работает, LAN нет, устройства ок; (3) после AR3.x — пусто ⇒ сохранение/чтение везде; presetRoot задан ⇒ доступ только внутри, снаружи 403.

---

## 7. Открытые вопросы

- **Q1** — оставлять ли per-endpoint loopback-гейты AC3.2 при loopback-бинде? Default — оставить (избыточно, но безвредно); чистка — опционально позже.
- **Q2** — presetRoot: одна папка или список? Из требования — одна папка. Реализуем одну; расширение до списка — при необходимости.
