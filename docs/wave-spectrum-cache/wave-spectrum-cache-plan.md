# wave-spectrum-cache — персистентный кэш волны и спектра (убрать «каждый раз заново»)

**Owner request (2026-07-19):**

1. **«Новый план + леджер. Ускорение загрузки волны и спектра.»**
2. **«Почему при открытии расписаний волна и спектр генерируются каждый раз заново? Ничего же не меняется, почему не используется кеш из предыдущей загрузи. Особенно это сильно заметно на больших расписания, например ForestMeditation»**
   *(цитата дословная, с опечатками источника: «загрузи», «расписания»).*

**Owner answers (уточнения объёма, 2026-07-19):**

- Инвалидация кэша — **по хэшу содержимого `.gnaural`**, а не по `path+size+mtime` (устойчиво к пустому пересохранению / `touch`). *(→ WC-D2)*
- Объём персистентного кэша — **WAV-рендер + overview-пирамида (грубые тиры)**; декод PCM и высокодетальные тайлы не персистим, они остаются ленивыми. *(→ WC-D3)*
- Владелец напомнил про уже существующую прогрессивную схему «грубый спектр сразу → детальные кадры в фоне поэтапно» и спросил про способы ускорения STFT на больших файлах. Схема найдена (фича `spectrogram-fixes`, SF11.x) и подтверждена чтением кода; она снижает воспринимаемую задержку **внутри живой сессии**, но не переиспользуется на свежем `open`. *(→ WC-D1)*

Ledger (authoritative): [wave-spectrum-cache-progress.json](wave-spectrum-cache-progress.json).

Методология — Plan + Ledger (как в [audio-panel-cleanup](../audio-panel-cleanup/audio-panel-cleanup-plan.md), [spectrogram-fixes](../spectrogram-fixes/spectrogram-fixes-plan.md)): атомарные покоммитные шаги с префиксом `WC1.1 …`, `verify` перед `done`, **на PAUSE-шагах останавливаемся и спрашиваем владельца**. Код лежит в трёх репозиториях: `MindWaveCore/server` (дисковый кэш + WS-роутинг), `GnauralCore/server` + `GnauralCore/ui` (движок анализа + UI), `SpectrumCore/src` (FPC-воркер STFT), протокол — `SharedPasCore/ts`.

---

## 1. Требования владельца (дословно → нумерованно)

> «Почему при открытии расписаний волна и спектр генерируются каждый раз заново? Ничего же не меняется, почему не используется кеш из предыдущей загрузи. Особенно это сильно заметно на больших расписания, например ForestMeditation»

1. Понять и объяснить, **почему** волна и спектр пересчитываются при каждом открытии расписания, хотя содержимое не менялось.
2. **Ускорить** повторное открытие: неизменённое расписание не должно рендериться и считаться заново.
3. Особый фокус — **большие расписания** (эталон: `ForestMeditation`), где эффект максимально заметен.

---

## 2. Что есть сейчас (verified 2026-07-19, всё проверено чтением кода — 3 explore-прохода)

### 2.1. Волна и спектр — один и тот же движок анализа

«Волна» ([WaveformView.vue](../../../GnauralCore/ui/components/WaveformView.vue)) = `spectrogram:get-peaks`; «спектр» ([SpectrogramView.vue](../../../GnauralCore/ui/components/SpectrogramView.vue)) = `spectrogram:get-tile`. Оба идут поверх **одного** анализа. Оба требуют одну тяжёлую цепочку: рендер `.gnaural` → WAV (Gnaural.exe) → декод всего WAV + STFT в воркере SpectrumCore.

Путь открытия: [WaveformView.vue:528-548](../../../GnauralCore/ui/components/WaveformView.vue#L528-L548) / [:564-570](../../../GnauralCore/ui/components/WaveformView.vue#L564-L570) → [use-spectrogram.ts:265-280](../../../GnauralCore/ui/composables/use-spectrogram.ts#L265-L280) (WS `spectrogram:open`) → [ui-ws-handler.ts:153-159](../../server/ui-ws-handler.ts#L153-L159) (роутинг на per-socket `SpectrogramSession`, создаётся на [:38-64](../../server/ui-ws-handler.ts#L38-L64)) → [spectrogram-session.ts:367-422](../../../GnauralCore/server/spectrogram-session.ts#L367-L422) (`onOpen` → `audioSource.acquire` → воркер `open-analysis`).

Рендер расписания в WAV: [spectrogram-audio-source.ts:65-101](../../../GnauralCore/server/spectrogram-audio-source.ts#L65-L101) — `Bun.spawn([exe, input, "-o", out])` в свежий `mkdtemp`, с переписыванием `<loops>N</loops>` → `<loops>1</loops>`. STFT: воркер [SpectrumCoreFftwWorkerProbe.pas](../../../SpectrumCore/src/apps/SpectrumCoreFftwWorkerProbe.pas).

### 2.2. Кэш есть, но не тот — два несвязанных механизма

**A. In-memory, привязан к WebSocket-соединению (то, что реально использует волна/спектр):**

- рефкаунт-кэш рендера (temp WAV, удаляется при release): [spectrogram-audio-source.ts:108-231](../../../GnauralCore/server/spectrogram-audio-source.ts#L108-L231), ключ `${kind}:${path}:${mtimeMs}:solo=…` ([:142](../../../GnauralCore/server/spectrogram-audio-source.ts#L142));
- warm-LRU анализов (`ANALYSIS_CACHE_MAX=6`, бюджет 3 ГБ), ключ по **mtime**: [spectrogram-session.ts:201-207](../../../GnauralCore/server/spectrogram-session.ts#L201-L207) / [:315-335](../../../GnauralCore/server/spectrogram-session.ts#L315-L335);
- кэш вычисленных тайлов.

**Всё уничтожается** при закрытии сокета / reload / навигации / рестарте сервера / вытеснении из LRU (>6 файлов): [ui-ws-handler.ts:76-80](../../server/ui-ws-handler.ts#L76-L80) → [spectrogram-session.ts:607-619](../../../GnauralCore/server/spectrogram-session.ts#L607-L619) → `SpectrogramAudioSource.dispose()` удаляет каждый temp-рендер ([:220-230](../../../GnauralCore/server/spectrogram-audio-source.ts#L220-L230)).

**B. Дисковый кэш + манифест (коммит `audio-cache-manifest`) — ДРУГОЙ конвейер:**

- [audio-cache-manifest.ts](../../server/audio-cache-manifest.ts) + `tmp/audio-render`, ключ `sha1(path+size+mtime+kind+discriminator)` ([server.ts:203-224](../../server/server.ts#L203-L224)), **переживает рестарты**;
- подключён **только к HTTP-эндпоинту** плеера/экспорта ([server.ts:269-318](../../server/server.ts#L269-L318), [:470-499](../../server/server.ts#L470-L499)), UI зовёт его через [audio-api.ts](../../../GnauralCore/ui/composables/audio-api.ts) для `<audio>`/экспорта;
- **WS-путь анализа его не использует** — `SpectrogramAudioSource` рендерит собственную одноразовую копию.

### 2.3. Прогрессивная схема «грубо → детально» уже есть (spectrogram-fixes, SF11.x)

Собрана из трёх механизмов и снижает воспринимаемую задержку **внутри живой сессии**:

1. overview-пирамида (мипмап, max-pool) + display-res STFT: [SpectrumCoreOverview.pas](../../../SpectrumCore/src/core/SpectrumCoreOverview.pas), [SpectrumCoreFftwWorkerProbe.pas:598-630](../../../SpectrumCore/src/apps/SpectrumCoreFftwWorkerProbe.pas#L598-L630). На отдалённом зуме — `ceil(N/2^zoom)` колонок × ≤32 FFT, max-pool. По плану SF: «cold overview ~3.9 s → <~100 ms»;
2. cross-zoom coarse fallback (SF11.9): [use-spectrogram.ts:196-213](../../../GnauralCore/ui/composables/use-spectrogram.ts#L196-L213) — растянутый грубый тайл рисуется мгновенно, резкие «допечатываются» поверх;
3. прогрессивное накопление тайлов (round-robin `get-tile`).

FFT-параметры конфигурируются на `open`: [spectrogram-protocol.ts:23-41](../../../SharedPasCore/ts/spectrogram-protocol.ts#L23-L41) (`window`, `hop`, `zeroPaddingFactor`, `winFunc`, `data`, `fscale` …); дефолт window 2048 / hop 512.

### 2.4. Диагноз («почему каждый раз заново»)

Прогрессивная схема (2.3) ничего не переиспользует на свежем `open`: единственный кэш на пути анализа — in-memory и привязан к сокету (2.2.A), персистентного нет вообще. Поэтому reload/навигация/рестарт → даже грубый overview считается заново с нуля: снова Gnaural-рендер, снова декод, снова STFT. **Лечится персистентностью**, а не улучшением отрисовки.

---

## 3. Решения (полные тексты — в леджере)

- **WC-D1** — корневая причина: единый движок анализа, кэши только in-memory/per-socket, персистентности нет; прогрессивная схема — это про перерисовку, а не про повторное открытие.
- **WC-D2** — ключ кэша = `sha1` **содержимого** `.gnaural` + `paramsHash` параметров анализа *(владелец, устойчивость к `touch`)*.
- **WC-D3** — объём: персистим **WAV-рендер + грубые тиры overview-пирамиды**; PCM и высокодетальные тайлы не персистим *(владелец)*.
- **WC-D4** — переиспользуем существующую дисковую инфру (`audio-cache-manifest` + `tmp/audio-render`), а не строим новую; WS-путь анализа впервые начинает её использовать *(память [reuse-standard-forms])*.
- **WC-D5** — персистентность overview — на стороне FPC-воркера (при `open-analysis` грузить/строить+писать пирамиду), ключ `contentHash+paramsHash`; требует пересборки `SpectrumCoreFftwWorkerProbe.exe`. Альтернатива (TS-сериализация через bridge) — вопрос **Q1** на PAUSE.

---

## 4. Фазы и шаги

Граф зависимостей (`dependsOn`) и проверка ацикличности — в леджере; `validate-ledger.js` обязан пройти перед каждым docs-коммитом *(память [ledger-status-field-slip])*.

**Фаза 0 — инвентаризация**: `WC0.1` план+леджер + verified-факты текущего состояния.

**Фаза 1 — персист WAV-рендера (content-hash), WS-путь берёт дисковый кэш**:
`WC1.1` content-hash `.gnaural` + расширение ключа дискового кэша · `WC1.2` MindWaveCore: acquire single-loop WAV по content-hash, прокидка в конструкцию `SpectrogramSession` · `WC1.3` `SpectrogramAudioSource` берёт инъектированный кэш-WAV вместо `mkdtemp+spawn` (read-only, не удалять общий файл) · **`WC1.4` PAUSE** — владелец гоняет реальное приложение.

**Фаза 2 — персист overview-пирамиды**:
`WC2.1` формат на диске (бинарные float32-тиры + заголовок: frameCount/tierCount/contentHash/paramsHash) · `WC2.2` воркер грузит пирамиду с диска если есть, иначе строит+пишет; пересборка exe · `WC2.3` session/bridge/протокол: передать cache-dir + contentHash + paramsHash в `open-analysis`, инвалидация по несовпадению · **`WC2.4` PAUSE** — владелец гоняет реальное приложение (холодный open на свежем сервере).

**Фаза 3 — инвалидация, housekeeping, Settings**:
`WC3.1` cap размера кэша + подключение новых записей к `audio-cache-manifest` summary/delete в Settings · `WC3.2` корректность инвалидации (изменение содержимого → пересчёт; `touch` без изменения → кэш-хит) · **`WC3.3` PAUSE** — финальное подтверждение на реальном приложении.

---

## 5. Риски

- **R1 — пересборка FPC-воркера.** `WC2.2` меняет `SpectrumCoreFftwWorkerProbe.pas` → нужно пересобрать `.exe` (память [gnaural-exe-is-ours-rebuild-it]); у бэкенда нет доступной консоли, логировать в `var/*.log` (память [bun-watch-ignores-cross-repo-server]).
- **R2 — ключ обязан включать параметры анализа.** Пирамида зависит от `window/hop/zeroPad/winFunc/…`; ключ = `contentHash + paramsHash`, иначе смена окна отдаст устаревшую пирамиду.
- **R3 — не сломать SF11.x.** Персистим только грубые тиры; высокий зум остаётся ленивым, cross-zoom fallback и накопление тайлов должны работать как прежде.
- **R4 — кросс-репо и артефакты.** Коммитим `git -C <repo>` по репозиториям, стейджим только свои файлы (память [multi-repo-commit-structure]); правки CRLF-безопасно (память [crlf-scripted-edits]); проверять только полным рестартом AppCore (память [bun-watch-ignores-cross-repo-server]).
- **R5 — рост диска.** Много больших расписаний → нужен cap и ручная очистка через Settings (`WC3.1`).
- **R6 — single-loop.** Кэшируемый WAV — single-loop (`<loops>1`), но ключ — по содержимому исходного `.gnaural`; артефакт single-loop, это корректно и совпадает с HTTP-конвейером.

---

## 6. Verify

- `GnauralCore` — `bun test ui server`.
- `MindWaveCore/ui` — `bun run typecheck` (vue-tsc) + `bun run build` (quasar). Серверный typecheck — локальный tsc 5.7.3 + throwaway tsconfig (память [server-typecheck-bunx-tsc-drift]).
- `validate-ledger.js` перед каждым docs-коммитом.
- **Гонять реальное приложение** (главный критерий): open `ForestMeditation` → reload/навигация → повторный open. Мерить: (1) второй open не запускает Gnaural.exe; (2) на холодном (свежий сервер) повторном open грубый overview появляется почти мгновенно, без полного STFT. Тайминги — в `var/*.log`. Полный рестарт AppCore для кросс-репо серверных правок.

---

## 7. Открытые вопросы

- **Q1** — ЗАКРЫТ (владелец, 2026-07-19): персистентность overview — **worker-side (FPC, WC-D5)**; TS-сериализация через bridge отклонена.
- **Q2** — нужен ли отдельный пункт «очистить кэш спектра» в Settings сейчас, или достаточно переиспользовать существующий summary/delete `audio-cache-manifest` (`WC3.1`). Default — переиспользовать.
