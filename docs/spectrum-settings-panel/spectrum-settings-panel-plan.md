# spectrum-settings-panel — «Параметры» на docable/detachable форму + блоки (плитки / аккордеон)

**Owner request (2026-07-16):** «Рефакторинг панели с настройками спектрограммы. Необходимо сделать
следующее:
1. Поместить содержимое этой панели на docable и detachable форму по аналогии с диалогом Открытия
   файлов и Списка треков
2. При отображении содержимого этой формы нужно следовать следующим правилам:
   а) каждая группа параметров оформляется в виде блока.
   б) если размер формы позволяет отобразить два блока по горизонтали, то вся форма отображает эти
      блоки в виде "плиток"
   в) если форма имеет вертикальную форму и не может отобразить двух блоков по горизонтаили, то
      блоки отображаются по вертикали в одну колонку в виде аккордеона»
*(цитата дословная, с опечаткой источника: «горизонтаили»)*

Ledger (authoritative): [spectrum-settings-panel-progress.json](spectrum-settings-panel-progress.json).
Методология Plan+Ledger — как в [panel-window](../panel-window/panel-window-plan.md) /
[wave-settings-dialog](../wave-settings-dialog/wave-settings-dialog-plan.md): atomic per-step commits
(префикс id шага, напр. `SS1.1 ...`), `verify` перед `done`, **пауза на owner-чекпоинтах**. Код —
целиком в **GnauralCore** (+ возможно 1 строка в `MindWaveCore/ui` при регистрации панели); докам —
коммиты в MindWaveCore. Коммитим по репозиториям раздельно, стейджим только свои файлы.

## 1. Требования владельца (дословно → нумерованно)

1. Содержимое панели настроек спектрограммы переезжает на **docable и detachable форму**, **по
   аналогии** с диалогом «Открытие файлов» и «Список треков».
2. Каждая **группа параметров** оформляется в виде **блока**.
3. Если размер формы позволяет отобразить **два блока по горизонтали** — форма отображает блоки
   **«плитками»**.
4. Если форма **вертикальная** и два блока по горизонтали не помещаются — блоки идут **по вертикали
   в одну колонку**, в виде **аккордеона**.

**Открытые вопросы к владельцу — см. §7** (пауза SS0.1). Ниже — предлагаемые ответы, помеченные
*(предложение)*; они не приняты, пока владелец не подтвердит.

## 2. Что уже есть (verified 2026-07-16, всё проверено чтением кода)

### 2.1. Сама панель — `SpectrogramSettingsPanel.vue`, и она **data-driven**

[SpectrogramSettingsPanel.vue](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue)
(346 строк) — единственная глобальная панель настроек спектрограммы в воркспейсе. Три части:

| Часть | Строки | Что это |
|---|---|---|
| Бар пресетов | [:3-34](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L3-L34) | SF18: `q-btn-dropdown` (список `store.allPresets`, ✓ на активном, `*` при modified) + «Сохранить как…» + «Управление…»; тут же `<spectrogram-preset-manager v-model="managerOpen" />` |
| **Группы** | [:36-103](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L36-L103) | `v-for="group in groups"` → заголовок группы `<div class="spectrogram-settings__title">` + `v-for` по полям |
| Действия | [:105-107](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L105-L107) | одна кнопка «Сброс» → `store.reset()` |

**Ключевой факт для req 2:** группы **не размечены руками** — это `computed<Group[]>`
([:229-280](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L229-L280)), отрисованный
одним `v-for` ([:37](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L37)). Значит
«оформить каждую группу блоком» — это правка **одного** `v-for` и CSS, а не переписывание 17 полей.
`computed` (а не константа) — намеренно: заголовки/лейблы реактивны к смене локали (SF13.1/SF13.2).

Четыре группы (SF-D35 + SF-D51) — это и есть «группы параметров» из req 2:

| Группа | i18n-ключ | Поля |
|---|---|---|
| `scale` | `audio.spectrogramGroupScale` («Масштаб») | `fscale`, `startHz`, `stopHz` — 3 поля |
| `color` | `audio.spectrogramGroupColor` («Цвет») | `scale`, `gain`, `drange`, `limit`, `frequencyGain`, `saturation`, `palette` — 7 полей |
| `fft` | `audio.spectrogramGroupFft` («FFT-фильтр») | `data`, `window`, `winFunc`, `zeroPaddingFactor`, `overlap` — 5 полей |
| `sharpness` | `audio.spectrogramGroupSharpness` («Резкость») | `imageScaling`, `highZoomMode`, `highZoomThreshold`, `highZoomWindow` — 4 поля |

Группы **сильно разной высоты** (3 … 7 полей) — это прямо влияет на вид «плиток» (см. R1).
Виды контролов: `select` / `number` / `slider` / `spin`
([:188](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L188)); у каждого поля —
иконка `help_outline` с `q-menu` (SF13.3).

**API компонента: пропов и эмитов нет вообще** — он ходит в глобальный Pinia-стор
`useSpectrogramStore()` ([:133](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L133))
и биндит `v-model` **прямо на `store.settings`** через алиасы `sNum`/`sVal`
([:134-138](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue#L134-L138)). Ни
apply/cancel, ни промежуточной модели нет — правка мгновенна. Поэтому хост монтирует его голым
тегом: `<spectrogram-settings-panel />`.

### 2.2. Как панель показывается сегодня — свой фиксированный флайаут, НЕ q-drawer

Хост — [TracksPanel.vue](../../../GnauralCore/ui/components/TracksPanel.vue):

- бэкдроп [:1134-1141](../../../GnauralCore/ui/components/TracksPanel.vue#L1134-L1141) (клик = закрыть)
  + `<aside id="tracks-panel-settings" role="dialog" aria-modal="false">`
  [:1142-1164](../../../GnauralCore/ui/components/TracksPanel.vue#L1142-L1164) со своей шапкой
  (заголовок `audio.spectrogramSettingsTitle` + крестик) и телом; сама панель —
  [:1161](../../../GnauralCore/ui/components/TracksPanel.vue#L1161), lazy
  ([:1294](../../../GnauralCore/ui/components/TracksPanel.vue#L1294));
- CSS [:3269-3284](../../../GnauralCore/ui/components/TracksPanel.vue#L3269-L3284):
  `position: fixed`, **`width: 300px`**, `z-index: 60`, приколота к рамке редактора через
  `--tp-right/--tp-top/--tp-bottom`;
- видимость — **локальный `ref`, не стор**: `spectrogramSettingsOpen`
  [:2649](../../../GnauralCore/ui/components/TracksPanel.vue#L2649) + toggle/close
  [:2650-2655](../../../GnauralCore/ui/components/TracksPanel.vue#L2650-L2655);
- кнопка `icon="tune"` в тулбаре [:122-130](../../../GnauralCore/ui/components/TracksPanel.vue#L122-L130)
  (`aria-controls="tracks-panel-settings"`, красится в `primary` при открытии);
- Escape закрывает [:2828-2830](../../../GnauralCore/ui/components/TracksPanel.vue#L2828-L2830);
- участвует в `anyOverlayOpen` [:2923](../../../GnauralCore/ui/components/TracksPanel.vue#L2923) →
  watch [:2935-2944](../../../GnauralCore/ui/components/TracksPanel.vue#L2935-L2944) вешает
  `resize`/`scroll` и меряет рамку `--tp-*` для fixed-флайаутов.

### 2.3. Контрол `@panel` и оба прецедента — готовы к третьему потребителю

`MindWaveCore/ui/src/components/panel/`: `PanelWindow.vue` (хром), `use-panel-window.ts`
(состояние+персист), `use-panel-bridge.ts` (мост), `panel-registry.ts` (контракт). Алиас `@panel`
(`quasar.config.ts:30` + `tsconfig.json:18`).

- **Пропы** `PanelWindow.vue:68-83`: `state`, `title`, `icon?`, `allowDetach?` (**default `true`** —
  там висит предупреждение PW5.7c: type-only Boolean **absent → false**, из-за чего режим однажды
  молча пропал у обеих панелей), `bridgeState?` (снимок для detached-ребёнка, PW5.7). **Эмиты**
  `:85-89`: `close`, `panelEvent`. **Слоты** `:46-47`: default + **`footer`**.
- Состояние — **не Pinia**: `usePanelWindowState(panelId, opts)` — модульный `Map`-синглтон
  (`use-panel-window.ts:119`), `{open, mode: floating|left|right|top|bottom|detached, prevMode,
  dockSize, floatRect, minFloatW=460, minFloatH=320}`, персист по полям в
  `mindwave-panel-<id>-*`. **Важно для нас:** раз это модульный синглтон, до состояния панели
  одинаково дотягиваются и тулбар в TracksPanel, и хост в AudioPage — без пробрасывания пропов.
- Шаблон потребителя — три части: тонкий **Dialog** (хром + состояние + мост), **Panel** (контент,
  без оконной логики), **panel-state store**. Оба живых примера:
  [FileOpenDialog.vue:6-19](../../../GnauralCore/ui/components/FileOpenDialog.vue#L6-L19) +
  [FileOpenPanel.vue](../../../GnauralCore/ui/components/FileOpenPanel.vue) +
  [stores/file-open-panel.ts](../../../GnauralCore/ui/stores/file-open-panel.ts);
  [TrackListDialog.vue:8-19](../../../GnauralCore/ui/components/TrackListDialog.vue#L8-L19) +
  `TrackListPanel/TrackListRemote/TrackListView` + [stores/track-list-panel.ts](../../../GnauralCore/ui/stores/track-list-panel.ts).
- Хост обоих — [AudioPage.vue:133-151](../../../GnauralCore/ui/pages/AudioPage.vue#L133-L151): один
  общий `audio-page__dock-wrap` + `<Teleport to="body" :disabled="!<...>Floating">`.
- Реестр detached-контента — **манифест модуля** ([GnauralCore/ui/module.ts:20-38](../../../GnauralCore/ui/module.ts#L20-L38),
  `panels: [{id, titleKey, icon, component, events}]`), плоско собирается
  `MindWaveCore/ui/src/modules/index.ts:40`, резолвится по id в `PanelHostPage.vue:33`
  (роут `/panel/:panelId` вне MainLayout). Никаких enum/switch — только запись в манифест.
- Ярлыки режимов уже общие и переведены (`panel.dockMenu/dockFloat/…/detach/close`,
  `MindWaveCore/ui/src/i18n/locales/{ru,en}.json`) — новая панель добавляет только свой заголовок.
- **ResizeObserver внутри `@panel` не используется вовсе** (там всё на pointer-drag). Но в проекте
  он — рутина: 6 мест (`FsEntryList.vue:315-320` — прямо внутри file-open-панели, `GTrackView`,
  `SpectrogramView`, `WaveformView`, `GnauralScheduleView`, `SpectrogramMinimap`), **все** под
  охраной `typeof ResizeObserver !== 'undefined'`.

### 2.4. Прецеденты, которые прямо задают ответы

- **`FileOpenPanel` уже принимает layout-проп от обёртки** (`:column="isColumn"`,
  [FileOpenDialog.vue:6-19](../../../GnauralCore/ui/components/FileOpenDialog.vue#L6-L19)) — то есть
  «контент подстраивается под форму окна» в этом контроле уже узаконено.
- **`q-expansion-item` в воркспейсе используется ровно в одном файле** —
  [GTrackSpectrumSettings.vue:7,40](../../../GnauralCore/ui/components/GTrackSpectrumSettings.vue#L7)
  (per-lane компактный редактор тех же `SpectrogramSettings`). Это готовый образец аккордеона
  (req 4) внутри той же предметной области.
- **PW5.2 уже проходил ровно наш путь** — комментарий
  [TracksPanel.vue:2921-2922](../../../GnauralCore/ui/components/TracksPanel.vue#L2921-L2922):
  «`Список треков` panel is a PanelWindow (owns its own positioning), so it no longer uses the
  scroll-frame pinning (`--tp-*`)». То есть переезд на PanelWindow **обязан** снять панель с
  `anyOverlayOpen`/`--tp-*` — прецедент это уже сделал, нам достаточно повторить.

### 2.5. Смежное, что НЕ трогаем (+ мина под переименованием)

- **`GTrackSpectrumSettings.vue`** — отдельная per-lane поверхность над тем же типом
  `SpectrogramSettings`, но на `v-model` (props/emits), а не на глобальном сторе; продублирована
  **намеренно** («so the frozen tab is untouched (risk R7)», :4). Вне объёма.
- **Мёртвый «остров» в AudioPage** (это WS2.1, отложен владельцем — см.
  [wave-settings-dialog-plan.md §8](../wave-settings-dialog/wave-settings-dialog-plan.md)): у
  AudioPage есть **свой** импорт `SpectrogramSettingsPanel`
  ([:508](../../../GnauralCore/ui/pages/AudioPage.vue#L508)), свой `spectrogramSettingsOpen`
  ([:1420-1425](../../../GnauralCore/ui/pages/AudioPage.vue#L1420-L1425)), свой Escape
  ([:1675](../../../GnauralCore/ui/pages/AudioPage.vue#L1675)) и весь CSS
  ([:2215-2270](../../../GnauralCore/ui/pages/AudioPage.vue#L2215-L2270)) — **но шаблон его не
  рендерит** (проверено: шаблон кончается на
  [:426](../../../GnauralCore/ui/pages/AudioPage.vue#L426), вхождений тега нет).
  **Практическое следствие → SS-D2: файл `SpectrogramSettingsPanel.vue` переименовывать нельзя** —
  мёртвый импорт на :508 живой для сборщика, и переименование уронит typecheck, втянув в нашу фичу
  отложенную владельцем чистку. Имя остаётся, роль меняется.

## 3. Решения (SS-D1 … SS-D8)

- **SS-D1 — третий потребитель `@panel`; хост — AudioPage, в общем доке; кнопка `tune` остаётся на
  месте.** Новый `stores/spectrum-settings-panel.ts` →
  `usePanelWindowState('spectrum-settings', {defaultMode: 'floating', defaultDockSize: 320})` (ключи
  дефолтные `mindwave-panel-spectrum-settings-*`; legacy-ключей нет — сегодняшняя видимость
  вообще не персистится, это локальный `ref`, §2.2). Новый `SpectrumSettingsDialog.vue`
  (PanelWindow-обёртка) хостится в `audio-page__dock-wrap` рядом с двумя другими (AudioPage:133-151),
  с тем же `<Teleport to="body" :disabled="!floating">`.
  **Почему AudioPage, а не TracksPanel:** PW-D9 держал «Список треков» внутри TracksPanel
  вынужденно — `gtracks` там per-call фабрика, и второй хост породил бы второй инстанс состояния;
  у нас состояние — **глобальный Pinia-синглтон**, поэтому это ограничение к нам не применяется
  вовсе. Зато применяется PW-D10: у `q-tab-panels` нет `keep-alive`, TracksPanel уничтожается при
  каждом переключении вкладки, так что панель, захостенная оттуда, не переживёт вкладку. Хост в
  AudioPage даёт то же поведение, что у «Открыть файл»/«Список треков» (req 1: «по аналогии»).
  Кнопка `tune` **остаётся в тулбаре TracksPanel** (владелец её туда ставил, SF-D5) и переключает
  `panel.open` общего состояния — `usePanelWindowState` модульный синглтон, так что тулбар в
  TracksPanel и хост в AudioPage видят один объект без пропов (§2.3).
- **SS-D2 — расщепление компонента: View + два адаптера (образец PW5.7), имя `…Panel.vue`
  сохраняется.**
  - `SpectrogramSettingsView.vue` — **чистое view**: пропы = снимок (`settings`, `presets`,
    `activePresetId`, `isModified`) + layout, эмитит **один сериализуемый `action`**. Вся разметка
    блоков/плиток/аккордеона живёт **здесь**.
  - `SpectrogramSettingsPanel.vue` — **in-window адаптер** (имя файла и путь **не меняются**, §2.5):
    читает стор, отдаёт снимок во View, применяет `action` к стору.
  - `SpectrogramSettingsRemote.vue` — **child-адаптер**: рендерит снимок родителя, шлёт `action` в
    мост; **своего стора и своей персистентности не имеет**.
  - Общий `applySpectrumSettingsAction(store, action)` — один и тот же код применяет действие на
    обеих сторонах (единственный источник правды — родительский стор).
- **SS-D3 — detach ОБЯЗАН быть «пультом» (PW5.7); наивный вариант проверен и сломан.**
  Проверено (grep по `stores/`, `composables/`, `components/`): **слушателя события `storage` нет
  нигде** в GnauralCore/ui, а стор пишет три ключа (`mindwave-spectrogram-settings`,
  `-user-presets`, `-active-preset`) deep-watch'ами (`stores/spectrogram.ts:121-123`). Значит
  «наивное» detached-окно со своим Pinia:
  - **(a) молча не работает:** ребёнок правит **свой** стор → родительский `renderOptions`/
    `analysisParams` не меняются → спектрограмма в главном окне **не перерисовывается**. Это ровно
    то, ради чего панель существует;
  - **(b) затирает данные:** deep-watch'и **обоих** окон пишут одни и те же 3 ключа →
    last-writer-wins.
  **Отличие от PW-D11 существенно и в нашу худшую сторону:** у «Списка треков» наивный ребёнок
  показывал **пустой список** — сломанность видно сразу. Здесь ребёнок будет выглядеть **полностью
  рабочим** (снимок из localStorage отрисуется, ползунки поедут) и просто ни на что не влиять —
  тихий отказ. Поэтому `allowDetach` включается **только** вместе с «пультом» (фаза 3), а до тех пор
  — явный `:allow-detach="false"` (и, как в PW5.7c, помня про absent→false: проп **обязан**
  передаваться явно, а не «опускаться»).
- **SS-D4 — переключатель «плитки ↔ аккордеон» — по ШИРИНЕ КОНТЕНТА, через ResizeObserver.**
  Переключение **структурное** (в аккордеоне блоки сворачиваются, в плитках — нет), поэтому чистым
  CSS (`@container`/media) не обходится — нужен JS-порог. `ResizeObserver` на теле панели, под
  охраной `typeof ResizeObserver !== 'undefined'` (конвенция всех 6 существующих мест, §2.3).
  Правило: **плитки при `contentWidth ≥ 2×MIN_BLOCK + gap`**, иначе аккордеон (req 3/4).
  Стартовое `MIN_BLOCK = 280px` (сегодняшняя колонка — фиксированные 300px и контролам её хватает;
  точное значение измеряется на реальных контролах в SS2.1), `gap = 8px` → порог ≈ **568px**.
  Сама сетка плиток — `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`: 2 колонки на
  пороге и 3-4 дальше сами собой (req 3 задаёт **условие** «два блока», а не потолок).
  Оба режима достижимы по построению: `minFloatW = 460` и `defaultDockSize = 320` (левый/правый док)
  < порога → аккордеон; док сверху/снизу — вся ширина редактора → плитки.
- **SS-D5 — аккордеон = `q-expansion-item`** по образцу `GTrackSpectrumSettings.vue` (§2.4) —
  единственного места в воркспейсе с этим контролом. Семантика раскрытия — **вопрос Q2 (§7)**;
  *(предложение)*: несколько блоков открыты одновременно, состояние персистится
  (`mindwave-panel-spectrum-settings-groups`), по умолчанию открыта первая группа.
- **SS-D6 — бар пресетов и «Сброс» — НЕ группы параметров** *(предложение, вопрос Q1 §7)*: бар
  пресетов относится сразу ко **всем** группам, поэтому остаётся полосой **над** блоками (в обоих
  режимах), а «Сброс» уезжает в **слот `footer`** PanelWindow (§2.3) — блоками оформляются только
  четыре группы из §2.1, ровно как сказано в req 2.
- **SS-D7 — i18n: нового заголовка не нужно.** Заголовок PanelWindow и `titleKey` в манифесте —
  существующий `audio.spectrogramSettingsTitle` («Параметры» / "Parameters", SF-D4), иконка `tune`
  (та же, что на кнопке). Ключи режимов дока/detach уже общие (§2.3). Новые ключи — только если
  Q1/Q2 потребуют подписей.
- **SS-D8 — пресет-менеджер в detached-окне** — **вопрос Q3 (§7)**. Проблема: «Сохранить как…»
  (`$q.dialog` prompt) и `SpectrogramPresetManager.vue` (rename/delete/duplicate/export/import) —
  это мутации стора, которых у ребёнка нет (SS-D3). Разложимо: **ввод** (prompt, выбор файла) —
  локальный UI ребёнка, **мутация** — один `action` в мост; `export` строится из снимка, `import`
  парсится у ребёнка и уезжает как payload. Выполнимо, но это **основной объём фазы 3**.

## 4. Фазы и шаги

Каждая фаза оставляет приложение рабочим; каждая заканчивается owner-чекпоинтом.

### Фаза 0 — план

- **SS0.1** — план + леджер (этот файл). **PAUSE:** владелец читает §7 (вопросы Q1-Q3) и
  подтверждает SS-D1/SS-D3 (хост + «пульт» как единственный способ detach).

### Фаза 1 — форма (req 1): dock/float, содержимое 1:1

- **SS1.1** — `stores/spectrum-settings-panel.ts` + `SpectrumSettingsDialog.vue` (PanelWindow,
  `:allow-detach="false"`, «Сброс» в `footer` при SS-D6) + хост в `audio-page__dock-wrap`
  (AudioPage) + кнопка `tune` переключает `panel.open`. Снос старого флайаута из TracksPanel:
  `aside`+бэкдроп+`transition` (:1134-1164), CSS (:3269-3284), локальный `ref`+toggle/close
  (:2649-2655), ветка Escape (:2828-2830), и — по прецеденту PW5.2 (§2.4) — вычёркивание
  `spectrogramSettingsOpen` из `anyOverlayOpen` (:2923). **Содержимое панели не трогаем.**
- **SS1.2** — **PAUSE**: owner-проверка формы (док слева/справа/сверху/снизу, floating, drag,
  ресайз, персист после F5, переключение вкладок).

### Фаза 2 — блоки (req 2-4)

- **SS2.1** — блоки + адаптивность в `SpectrogramSettingsPanel.vue`: каждая группа — блок;
  ResizeObserver + порог (SS-D4); плитки = CSS-grid `auto-fill/minmax`; аккордеон =
  `q-expansion-item` (SS-D5). Правится **один `v-for`** (§2.1) + CSS. Измерить реальное `MIN_BLOCK`
  на самой широкой группе («Цвет», 7 полей) и зафиксировать в леджере.
- **SS2.2** — **PAUSE**: owner-проверка вида (плитки/аккордеон, порог, поведение на границе — R1).

### Фаза 3 — detach (req 1, вторая половина)

- **SS3.1** — расщепление SS-D2: `SpectrogramSettingsView.vue` (вся разметка фазы 2 переезжает сюда
  целиком, без переписывания) + `SpectrogramSettingsPanel.vue` как in-window адаптер +
  `applySpectrumSettingsAction`. Поведение в главном окне 1:1, detach ещё выключен.
- **SS3.2** — `SpectrogramSettingsRemote.vue` + запись в `panels[]` манифеста
  (`id: 'spectrum-settings'`, `events: ['action']`) + `:bridge-state="snapshot"` + снятие
  `allow-detach=false`. Объём пресет-менеджера — по ответу на Q3.
- **SS3.3** — **PAUSE**: owner-проверка detached-окна, **в т.ч. в AppCore** (не только в браузере):
  правка в отдельном окне перерисовывает спектрограмму в главном; закрытие главного закрывает
  ребёнка; геометрия переживает переоткрытие.

## 5. Риски

| # | Риск | Смягчение |
|---|---|---|
| R1 | **Дрожание на пороге.** Аккордеон свёрнут → нет скроллбара → ширина контента больше → плитки → выше → появился скроллбар → ширина меньше → аккордеон → … Классическая петля обратной связи через скроллбар | Мерить **border-box контейнера, ширина которого не зависит от содержимого** (тело панели), а не скроллируемого контента; плюс `scrollbar-gutter: stable`; если и этого мало — гистерезис (в плитки при ≥ порога, обратно при ≤ порог−24px). Проверяется медленным ресайзом на границе (SS2.2) |
| R2 | Группы очень разной высоты (3 vs 7 полей) → в плитках рваная сетка/дыры | `align-items: start` (блоки по своей высоте, не тянутся); при желании владельца — masonry-подобный порядок; решается на SS2.2 глазами |
| R3 | Панель перестаёт быть модальной: сегодня есть бэкдроп (клик = закрыть) и Escape; у PanelWindow ни того, ни другого нет по природе дока | Это **прямое следствие req 1** («по аналогии» с двумя панелями — у них тоже нет). Escape при желании возвращается через `@keydown` на PanelWindow — так делает FileOpenDialog (§2.3). Отметить владельцу на SS1.2 |
| R4 | Два окна пишут одни и те же 3 ключа настроек | Снято **по построению** в SS-D3: у ребёнка нет ни стора, ни персистентности — только снимок + `action` |
| R5 | `allowDetach` — type-only Boolean: **absent → false** (грабли PW5.7c, из-за которых режим уже молча пропадал у обеих панелей) | Проп передаём **явно** в обеих фазах (`false` в 1-2, убрать/`true` в 3); проверять живьём пункт меню, а не только typecheck |
| R6 | Переименование `SpectrogramSettingsPanel.vue` уронило бы typecheck через мёртвый импорт AudioPage:508 и втянуло бы отложенную владельцем чистку WS2.1 | SS-D2: имя файла сохраняется, новым файлом становится `…View.vue` (§2.5) |
| R7 | Тесты на панель отсутствуют, а в фазе 3 появляется чистая логика (`applySpectrumSettingsAction`) | Именно её и покрыть bun-тестом в SS3.1 (прецедент: SF18.1 тестирует семантику действий стора). Разметку — глазами на PAUSE |

## 6. Верификация (каждый шаг)

- `bun run typecheck` (vue-tsc) + `bun run build` (quasar) из **`MindWaveCore/ui`** — **не**
  `bunx vue-tsc` (мисматч версии TS); vue-tsc тянет GnauralCore по графу импортов.
- `bun test ui server` из **GnauralCore** — существующие сьюты зелёные; новый тест на
  `applySpectrumSettingsAction` в SS3.1.
- **Главная проверка — прогон реального приложения** (typecheck здесь почти ничего не значит: фича
  — разметка + геометрия). Ручной сценарий: все 5 режимов дока + floating; порог плиток/аккордеона
  на медленном ресайзе (R1); правка любого поля **немедленно** перерисовывает спектрограмму;
  пресеты (применить/сохранить/`*`-modified) и «Сброс» живы; персист после F5; переключение вкладок
  не роняет панель (PW-D10); detached (фаза 3) — правка в ребёнке перерисовывает график в
  родителе, закрытие главного закрывает ребёнка. Фаза 3 проверяется **и в AppCore**, не только в
  браузере (PW-D1: там это default-popup WebView2).
- Браузерного драйвера в воркспейсе нет (проверялось в WS1.1) — визуальную часть смотрит владелец
  на PAUSE-шагах; это заложено в план, а не пропуск.

## 7. Открытые вопросы к владельцу (PAUSE SS0.1)

- **Q1 (SS-D6) — бар пресетов и «Сброс»:** *(предложение)* бар пресетов — полоса над блоками,
  «Сброс» — в подвале окна; блоками оформляются только 4 группы параметров. Или владелец хочет
  пресеты **тоже** отдельным блоком (тогда их 5, и в плитках пресеты станут плиткой)?
- **Q2 (SS-D5) — аккордеон:** *(предложение)* можно раскрыть **несколько** блоков сразу,
  раскрытое состояние персистится, по умолчанию открыта первая группа. Или классический аккордеон
  — **ровно один** открытый блок?
- **Q3 (SS-D8) — detached-окно и пресеты:** нужен ли в отдельном окне **полный** пресет-менеджер
  (переименование/удаление/дублирование/экспорт/импорт), или достаточно **применения** пресета +
  «Сохранить как…», а «Управление…» открывается только в главном окне? Это заметно меняет объём
  SS3.2.
- **Q4 — порог плиток:** устраивает ли правило «плитки, начиная с ~568px ширины контента» и то, что
  на широком доке (сверху/снизу) колонок станет 3-4, а не ровно 2?

## 8. Ссылки

- Требования: этот файл §1 (цитата дословно).
- Леджер: [spectrum-settings-panel-progress.json](spectrum-settings-panel-progress.json).
- Код: [SpectrogramSettingsPanel.vue](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue),
  [TracksPanel.vue](../../../GnauralCore/ui/components/TracksPanel.vue) (хост+тулбар),
  [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue) (док-врап),
  [stores/spectrogram.ts](../../../GnauralCore/ui/stores/spectrogram.ts),
  [SpectrogramPresetManager.vue](../../../GnauralCore/ui/components/SpectrogramPresetManager.vue),
  [GTrackSpectrumSettings.vue](../../../GnauralCore/ui/components/GTrackSpectrumSettings.vue)
  (образец `q-expansion-item`), [module.ts](../../../GnauralCore/ui/module.ts) (реестр панелей).
- Контрол: `MindWaveCore/ui/src/components/panel/` (`PanelWindow.vue`, `use-panel-window.ts`,
  `use-panel-bridge.ts`, `panel-registry.ts`), алиас `@panel`.
- Прецеденты: [panel-window](../panel-window/panel-window-plan.md) — PW-D3 (контрол), PW-D4
  (реестр), PW-D5 (мост), PW-D6 (жизненный цикл detached), PW-D9/PW-D10 (размещение хоста),
  **PW-D11 + PW5.7 («пульт» — прямой образец SS-D2/SS-D3)**;
  [spectrogram-fixes](../spectrogram-fixes/spectrogram-fixes-plan.md) — SF-D4/SF-D5 (панель
  «Параметры» и её кнопка), SF-D35 (группы), SF-D51 («Резкость»), SF18/SF-D53 (пресеты);
  [wave-settings-dialog §8](../wave-settings-dialog/wave-settings-dialog-plan.md) (мёртвый остров
  AudioPage — WS2.1, отложен; причина SS-D2/R6).
