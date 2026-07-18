# viewmode-graph-header — план

## Требование владельца (verbatim)

> Новый план. Нужно убрать дроп-даун со списком типов отображения "Волна+спектр" из общего
> тулбара и отображать его только в хедерах графиков, где есть волна или спектр перед шестерёнкой

Нумерованно:

1. Убрать дроп-даун со списком типов отображения («Волна + Спектр» и др.) из **общего тулбара**
   вкладки «Треки».
2. Отображать этот же дроп-даун **только в хедерах графиков**, где есть волна или спектр, —
   **перед шестерёнкой** (кнопкой настроек).

## Контекст (что есть сейчас)

- Дроп-даун `viewMode` — Audacity-стиль `q-btn-dropdown` (icon `layers`, `:label="viewModeLabel"`)
  в общем тулбаре: [TracksPanel.vue:62-79](../../../../GnauralCore/ui/components/TracksPanel.vue).
- Значения: `AudioViewMode = 'waveform' | 'spectrogram' | 'both' | 'overlay'`, список
  `AUDIO_VIEW_MODES` — локально в `TracksPanel.vue` (~строки 1897-1898). Локальный `ref` viewMode
  (~1924), персист в localStorage `mindwave-tracks-waveform`, плюс синхронизация с проектом
  (`currentWaveformPrefsObject`/`applyWaveformPrefsObject`). i18n-ключи
  `audio.viewMode_*` уже есть (ru/en).
- Потребление: computed `showWaveform` (`waveform`|`both`), `showSpectrogram` (`!== 'waveform'`),
  `waveformOverlay` (`overlay`) — гейтят рендер общих стеков волны/спектра.
- Хедеры общих графиков (класс `tracks-panel__gtrack-header tracks-panel__overall-header`),
  каждый заканчивается связкой «title (flex:1) → шестерёнка `header-gear`»:
  - общий **волновой** хедер — [TracksPanel.vue:381-424](../../../../GnauralCore/ui/components/TracksPanel.vue),
    title `audio.tracksOverallWave`, gear `openWaveformSettingsGroup`;
  - общий **спектральный** хедер — [TracksPanel.vue:480-523](../../../../GnauralCore/ui/components/TracksPanel.vue),
    title `audio.tracksOverallSpectrum`, gear → `spectrumSettingsPanel.open`.

## Решения

- **VH-D1** — Убрать дроп-даун `viewMode` (`q-btn-dropdown icon="layers"`, TracksPanel.vue:62-79)
  из общего тулбара целиком. Комментарий SF23.3 удалить вместе с блоком.
- **VH-D2** — Область: тот же дроп-даун показывать **только в двух общих хедерах** (волна, спектр),
  перед шестерёнкой. В **per-lane (gtrack) хедеры НЕ добавлять** — там свои переключатели soloMode,
  а `viewMode` — глобальный «общий» режим. Выбор владельца (AskUserQuestion 2026-07-18: «Только
  общие графики»).
- **VH-D3** — Достижимость контрола обеспечена самим гейтингом: в любом режиме виден ≥1 общий хедер
  (`both`/`overlay` → оба; `waveform` → только волновой; `spectrogram` → только спектральный), значит
  дроп-даун всегда доступен. В `both`/`overlay` он появляется в обоих хедерах — это допустимо и
  консистентно (оба меняют один глобальный `viewMode`). Дублировать логику НЕ нужно — общий компонент.
- **VH-D4** — Вид: **только иконка** (`icon="layers"`, без `:label`), размер под хедер
  (`dense flat round size="xs"`, как соседняя `header-gear`), текущий режим виден галочкой в списке
  и в тултипе. Тултип = `t('audio.viewMode')`. Выбор владельца (AskUserQuestion 2026-07-18: «Только
  иконка»).
- **VH-D5** — Переиспользование (см. память reuse-standard-forms): вынести дроп-даун в маленький
  общий компонент `ViewModeDropdown.vue` (`v-model` ↔ `viewMode`), используемый в обоих хедерах,
  вместо дублирования разметки. Тип `AudioViewMode` + `AUDIO_VIEW_MODES` вынести в общий модуль
  `ui/composables/audio-view-mode.ts`, чтобы и компонент, и `TracksPanel` импортировали один источник
  (никаких циклов, никаких дублей списка). Персист/синхронизация `viewMode` остаются в TracksPanel
  без изменений — компонент чисто презентационный (`modelValue`/`update:modelValue`).

## Шаги по фазам

### Фаза 1 — общий модуль + компонент
- **VH1.1** — `ui/composables/audio-view-mode.ts`: экспорт `AudioViewMode` + `AUDIO_VIEW_MODES`
  (перенос из TracksPanel). TracksPanel импортирует их, локальные объявления удалены; `viewModeLabel`,
  persist и computed продолжают работать.
- **VH1.2** — `ui/components/ViewModeDropdown.vue`: icon-only `q-btn-dropdown` (`layers`), проп
  `modelValue: AudioViewMode`, эмит `update:modelValue`, список из `AUDIO_VIEW_MODES` с i18n
  `audio.viewMode_*` и галочкой активного, тултип `audio.viewMode`. Лёгкий unit-тест (рендер опций,
  эмит выбора).

### Фаза 2 — проводка в TracksPanel
- **VH2.1** — TracksPanel.vue: удалить блок дроп-дауна из тулбара (VH-D1); импортировать и вставить
  `<view-mode-dropdown v-model="viewMode" />` перед шестерёнкой в обоих общих хедерах (волна: после
  title ~411; спектр: после title ~510).

### Фаза 3 — верификация
- **VH3.1** — `bun test ui server`, `bun run typecheck` (vue-tsc), `bun run build` (quasar). Прогнать
  реальное приложение: переключение режимов из хедеров, все 4 режима достижимы, тулбар без дроп-дауна.
- **VH3.2** — **PAUSE**: приёмка владельцем в реальном приложении.

## Риски

- EOL: `GnauralCore/ui/*` — LF; i18n JSON — CRLF (см. память crlf-scripted-edits). Новых i18n-ключей
  нет. Сохранять EOL при правках.
- Дублирование дроп-дауна в `both`/`overlay` (два хедера) — ожидаемо (VH-D3), не баг.
- Не задеть persist/синхронизацию `viewMode` при выносе типа (VH1.1) — компонент презентационный.

## Верификация

vue-tsc 0 ошибок; quasar build exit 0; `bun test ui server` без регрессий; ручной прогон приложения
(VH3.1) + приёмка владельца (VH3.2).
