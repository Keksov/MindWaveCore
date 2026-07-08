# gtrack-editor — новый редактор gnaural-треков на одной форме с волной и спектром

**Owner request (2026-07-08):** переработать редактор gnaural-треков так, чтобы gnaural-треки
(далее **gtrack**) были видны одновременно с волной и спектром на одной форме. Текущий
gnaural-редактор **не трогаем** — новый пишется с нуля, но с опорой на существующий код.
Сначала — новый редактор gtrack; синхронизация волнового и XML представлений — потом.

Ledger (authoritative): [gtrack-editor-progress.json](gtrack-editor-progress.json).
Методология Plan+Ledger — как в [spectrogram-fixes](../spectrogram-fixes/spectrogram-fixes-plan.md):
atomic per-step commits (префикс id шага), verify перед done, пауза на owner-чекпоинтах.

## 1. Требования владельца (дословно → нумерованно)

1. Новый редактор gtrack, старый (вкладка «Редактор»: CodeMirror XML + GnauralScheduleView)
   остаётся нетронутым.
2. gtracks видны **одновременно с волной и спектром** на одной форме.
3. Каждый gtrack может отображаться **в отдельной дорожке-редакторе**, по аналогии с
   аудио-дорожками.
4. В одной gtrack-дорожке можно отображать **один или несколько** gnaural-треков (voices)
   одновременно.
5. Режимы отображения/редактирования дорожки: **Base freq / Beat freq / Volume / Stereo balance**.
6. Если в gtrack есть **аудио-фрагменты** (voice type audiofile) — отображать их как спектр /
   волну / оба, **инлайн в дорожке самого gtrack** или **собранными в отдельной дорожке**
   редактора. То же для типа **noise**.
7. **Вершины-точки** (entries), в которых задаются параметры: режим выбора/редактирования точек
   включается и выключается; редактирование **перетаскиванием мышкой за точку** и **через диалог
   параметров выбранной точки**.
8. Фаза 2 (после базового редактора): режим **синхронизации между волновым и XML
   представлениями** — обсудить отдельно.

## 2. Что уже есть (verified 2026-07-08)

- **Модель расписания**: `GnauralScheduleData / Voice / Entry` в
  [SharedPasCore/ts/protocol.ts](../../../SharedPasCore/ts/protocol.ts) (~строка 700): voices с
  `type/typeIndex/description/hidden/muted/mono/color/audioFilePath`, entries с
  `startSec/endSec/durationSec`, `baseFreqStart/End`, `beatFreqHalfStart/End`,
  `volL/volR Start/End`. Сервер строит её через `Gnaural.exe --dump-schedule`
  (gnaural-session.ts), клиент кэширует в `stores/audio.ts` (`gnauralScheduleCache`).
- **Сохранение XML**: `server/gnaural-editor-store.ts` — атомарная запись
  (temp → валидация `Gnaural.exe --dump-schedule` → rename).
- **Рендер-мост**: `server/spectrogram-audio-source.ts` **уже** рендерит `.gnaural → WAV` для
  анализа — волна/спектр для gnaural-файла работают существующим путём.
- **Стек дорожек**: вкладка Аудио, unified track model (SF-D66): kind/channel/visible/order,
  общий time view (`spectrogramShared`), минимап, ресайзеры, глаз/драг слева, шестерёнка справа.
- **Старый редактор**: `GnauralEditorPanel.vue` (1270) + `GnauralScheduleView.vue` (3197,
  канвас-просмотр voices: hidden/muted/color, overlay/tracks, log/linear, свой минимап;
  вершины НЕ редактируются). Используем как референс отрисовки, в код не лезем.

## 3. Решения (locked 2026-07-08, Q&A с владельцем)

- **GT-D1 — новый код рядом со старым.** Новые компоненты `GTrack*` (view, диалоги, модель);
  `GnauralEditorPanel` / `GnauralScheduleView` не изменяются. Переиспользуем: протокольную
  модель, dump-schedule, gnaural-editor-store (save+validate), рендер-мост, стек дорожек SF-D66.
- **GT-D2 — хост: вкладка Аудио, общий стек.** gtrack-дорожки — новый `kind:'gtrack'` в unified
  track model; общая шкала времени/зум/пан/минимап/ресайзеры/глаз/драг/шестерёнка. Появляются
  только когда открыт `.gnaural`.
- **GT-D3 — волна/спектр = рендер gnaural → WAV** (существующий механизм анализа). После Save —
  инвалидация анализа и перечитывание (перерендер по кнопке; авто-режим — опция позже).
- **GT-D4 — правки: модель в памяти + Save.** Редактируется реактивная копия расписания;
  undo/redo в памяти; dirty-флаг; Save (кнопка + Ctrl+S) сериализует и пишет через существующий
  store с валидацией.
- **GT-D5 — сохранение = патч исходного XML, не регенерация.** Дамп-модель может быть неполной
  (поля, которые `--dump-schedule` не отдаёт: типы волн, фазы и т.п.). Поэтому Save парсит
  исходный XML (DOMParser), точечно обновляет значения затронутых entries/voices и сериализует
  обратно — все неизвестные поля сохраняются. Полная регенерация — только если патч окажется
  нежизнеспособным (зафиксировать отдельным решением).
- **GT-D6 — производные оси.** Beat freq отображается как 2×`beatFreqHalf`; Volume =
  (volL+volR)/2, Stereo balance = из volL/volR; редактирование Volume/Balance маппится обратно
  в volL/volR (при mono — только volL).
- **GT-D7 — синхронизация волна↔XML — фаза 5**, отдельное обсуждение дизайна с владельцем
  до какого-либо кода.

## 4. Фазы и шаги (чеклист зеркалит леджер)

### Phase 1 — редактируемая модель + сохранение (без UI)
- [x] **GT1.1 — Editable-модель gtrack (клиент).** `gtrack-model.ts`: загрузка
  `GnauralScheduleData` → редактируемая копия; операции над вершинами (move/set params);
  undo/redo command-стек; dirty. Чистый TS + bun-тесты.
- [ ] **GT1.2 — XML-патчер (Save).** Модель+исходный XML → обновлённый XML (GT-D5); запись через
  существующий gnaural-editor-store API; round-trip verify: патч → `--dump-schedule` → сравнение
  с моделью (допуск на float).

### Phase 2 — gtrack-дорожки в стеке Аудио (read-only)
- [ ] **GT2.1 — GTrackView.vue.** Канвас-дорожка в стеке: кривые voices по режиму дорожки
  (Base/Beat/Volume/Balance), общий time view, цвета voices, лейбл, тот же хром (высота/ресайз,
  глаз+драг слева, шестерёнка справа).
- [ ] **GT2.2 — Управление дорожками.** Конфигурация: список gtrack-дорожек
  `{id, voiceIds[], mode}`; по умолчанию одна дорожка со всеми тональными voices; «+ дорожка»;
  шестерёнка дорожки: режим + чекбоксы voices; персист (per file). Интеграция в SF-D66
  (hide/show/reorder работают и для gtrack).
- [ ] **GT2.3 — PAUSE: owner-проверка** каркаса (gtracks + волна + спектр на одной форме).

### Phase 3 — редактирование вершин
- [ ] **GT3.1 — Режим точек.** Toggle в дорожке: показ вершин, hit-test, hover, выбор точки.
- [ ] **GT3.2 — Drag точек.** Перетаскивание (время + значение по режиму дорожки), клампы
  (соседние точки, допустимые диапазоны), live-обновление кривой, undo/redo.
- [ ] **GT3.3 — Диалог параметров точки.** Все параметры entry (время/длительность, base freq
  start/end, beat freq, volL/volR + производные Volume/Balance), apply → модель.
- [ ] **GT3.4 — Save-пайплайн.** Кнопка + Ctrl+S, dirty-индикатор, GT1.2-патч → валидация →
  атомарная запись; ошибки валидации — пользователю; после записи — инвалидация анализа,
  перерендер WAV, обновление волны/спектра (GT-D3).
- [ ] **GT3.5 — PAUSE: owner-проверка** полного цикла правок.

### Phase 4 — аудио-фрагменты и noise в редакторе
- [ ] **GT4.1 — Отдельная дорожка фрагментов.** Voices типа audiofile: волна/спектр/оба в
  выделенных дорожках стека (переиспользуем WaveformView/SpectrogramView с анализом файла
  фрагмента, позиционирование по startSec). Noise — представление решить при исполнении
  (см. риск R4).
- [ ] **GT4.2 — Инлайн в дорожке gtrack.** Те же фрагменты в самой gtrack-дорожке (полоса
  волны/спектра под кривыми); настройка per voice: inline / отдельная дорожка / скрыто.

### Phase 5 — синхронизация волна ↔ XML (дизайн)
- [ ] **GT5.1 — Дизайн-документ + Q&A с владельцем** (двунаправленность, конфликтные правки,
  гранулярность). Код — только после отдельного «go».

## 5. Риски

- **R1 — полнота патча XML (GT-D5).** Соответствие entry в дампе ↔ узла в XML (индексы,
  overallVol, loops). Проверяется round-trip'ом в GT1.2 до любого UI.
- **R2 — инвалидация анализа после Save.** Кэш анализа ключуется путём+параметрами — после
  перезаписи файла нужен принудительный re-open/перерендер (mtime в ключе или явный сброс).
- **R3 — ось времени при loops.** `totalTimeSec` расписания vs длительность отрендеренного WAV
  (loopCount>1): выравнивание шкалы gtracks и волны/спектра.
- **R4 — noise-фрагменты.** У noise нет файла; вол/спектр для него = либо рендер соло-voice
  через gnaural (дорого), либо синтетическое превью. Решить в GT4.1.
- **R5 — производительность канваса** при многих voices × many entries — рисовать по
  видимому окну (как SpectrogramView), не всю схему.

## 6. Верификация (каждый шаг)

Из `GnauralCore`: `bun test ui server`. Из `MindWaveCore/ui`: `npx vue-tsc --noEmit` и
`./node_modules/.bin/quasar build`. Для GT1.2 дополнительно: round-trip через
`Gnaural.exe --dump-schedule`. Ручная проверка владельцем на PAUSE-шагах (GT2.3, GT3.5).

## 7. Ссылки

- Модель: [protocol.ts](../../../SharedPasCore/ts/protocol.ts) (`GnauralScheduleData`)
- Save/валидация: [gnaural-editor-store.ts](../../../GnauralCore/server/gnaural-editor-store.ts)
- Рендер-мост: [spectrogram-audio-source.ts](../../../GnauralCore/server/spectrogram-audio-source.ts)
- Стек дорожек: [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue) (SF-D66)
- Референс отрисовки: [GnauralScheduleView.vue](../../../GnauralCore/ui/components/GnauralScheduleView.vue) (не трогаем)
- Старый редактор: [GnauralEditorPanel.vue](../../../GnauralCore/ui/components/GnauralEditorPanel.vue) (не трогаем)
