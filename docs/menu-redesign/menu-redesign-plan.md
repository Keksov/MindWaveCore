# menu-redesign — единое меню «Меню» (вертикальное, боковые подменю, MRU)

**Owner request (2026-07-14):** редизайн меню в форме Audio по образцу скриншота (единый выпадающий
список «Меню» с боковыми подменю). Дословные требования — раздел 1. Пункт «Выход» уточнён владельцем:
закрывает окно AppCore. Пункт 4 уточнён: запоминаются **команды меню** (MRU), не файлы.

Ledger (authoritative): [menu-redesign-progress.json](menu-redesign-progress.json).
Методология Plan+Ledger — как в [gtrack-editor](../gtrack-editor/gtrack-editor-plan.md) и
[panel-window](../panel-window/panel-window-plan.md): atomic per-step commits (префикс id шага,
напр. `MR1.1 ...`), `verify` (vue-tsc + quasar build + bun-тесты) перед `done`, пауза на
owner-чекпоинтах.

## 1. Требования владельца (дословно → нумерованно)

1. Один пункт в меню баре — **«Меню»**.
2. Из него выпадает **вертикальное подменю**; сейчас в нём только три пункта: **Файл** (→ Открыть),
   **Настройки**, **Выход**.
3. Каждый из пунктов может иметь **подменю, открывающееся вбок**.
4. **Последние пять использованных пунктов меню** отображаются под чертой (разделителем) после
   пункта «Выход».
5. Существующие пункты **Файл** и **Правка** (текущие два top-level дропдауна) нужно **удалить**.
7. Кнопка **«Экспорт»** должна уйти из тулбара и переместиться в **Меню → Файл → Экспорт**. По
   нажатию открывается **диалог**, в котором можно выбрать **тип файла** и **имя** сохраняемого файла.
8. Если у пункта меню есть подменю, оно должно **автоматически открываться** сбоку с небольшой,
   едва ощутимой задержкой при **наведении мыши** на пункт.
9. Контрол **«Выбранный файл»** переместить в **меню-бар справа от элемента «Меню»**. Поведение
   контрола должно остаться **идентичным** текущему.

Уточнения владельца (2026-07-14):
- 4a. «Пункты меню» = **команды меню** (MRU нажатых команд, напр. «Открыть», «Настройки»), а не
  недавние файлы (`audio.recentFiles` остаётся как есть — это отдельный контрол на форме).
- 6. **«Выход»** закрывает окно-хост **AppCore** (`window.close()`). В dev-браузере `window.close()`
  срабатывает только для script-открытых окон — там это фактически no-op (dev-ограничение, не влияет
  на прод, где AppCore хостит одно WebView2-окно).

## 2. Контекст текущей реализации

- Меню-бар живёт в форме Audio: [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue),
  `.audio-page__menubar` (:5–28) — **два** `q-btn-dropdown`: «Файл» (`t('audio.menuFile')`) с
  единственным пунктом «Открыть…» (`openFileDialog()`), и «Правка» (`t('audio.editMenu')`) с пунктом
  «Настройки» (`goToSettings()`, шорткат Ctrl+P). Комментарии FB4.1 / GT10.45.
- `openFileDialog()` открывает панель выбора файла (`filePanel.open`, PanelWindow-контрол).
  `goToSettings()` открывает двухпанельный диалог настроек (`settingsDialogOpen`); Ctrl+P на любой
  вкладке уже вызывает `goToSettings()` в `handlePlayerKeyDown` (:1551).
- i18n: `GnauralCore/ui/i18n/{ru,en}.json`, секция `audio` — ключи `menuFile`/`menuOpen`/`editMenu`/
  `openSettings` уже есть. `recentFilesEmpty` — это про недавние **файлы**, к MRU не относится.
- Логаута/landing-страницы в приложении нет (локальное SPA внутри AppCore). detached-окна панелей
  уже используют `window.close()` — тот же приём применим к «Выходу».
- **Экспорт (текущая реализация):** кнопка-дропдаун в
  [GnauralTransportControls.vue](../../../GnauralCore/ui/components/GnauralTransportControls.vue)
  (:21–38, `v-if="showExport"`, пункты wav/flac) эмитит `export` с форматом. В
  [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue) — три инстанса
  `GnauralTransportControls` (`:show-export="canExportCurrentFile"`, `@export="downloadSelectedAudio"`).
  `downloadSelectedAudio(format)` (:1667) тянет blob через `audioApi.fetchAudioFileBlob(path, _, {format})`
  и качает через `<a download>` с именем из `buildExportFileName` (:829). Экспорт доступен только для
  `.gnaural` (`canExportCurrentFile`, :835). Имя файла сейчас **не выбирается** — производится из
  исходного имени; тип выбирается пунктом дропдауна.
- Плейсмент Plan+Ledger — в `MindWaveCore/docs/` по общей конвенции (как gtrack-editor,
  file-browser), хотя код правится в `GnauralCore/ui`. Коммиты — по своим репозиториям
  (multi-repo rule): код → GnauralCore, доки → MindWaveCore.

## 3. Архитектура (принятые решения — детали в ledger `decisions`)

- **MR-D1. Единый дропдаун «Меню».** Два top-level `q-btn-dropdown` («Файл»/«Правка») заменяются
  ОДНИМ `q-btn-dropdown` с `label = t('audio.menuRoot')` («Меню»), внутри — вертикальный `q-list`.
  Содержимое строится из **декларативной модели меню** (см. MR-D2), чтобы боковые подменю и MRU были
  data-driven и легко расширялись (требование 3 — «каждый пункт может иметь подменю»).
- **MR-D2. Модель меню + рекурсивный рендер.** Массив записей
  `{ id, labelKey, icon?, shortcut?, run?(): void, children?: MenuNode[], disabled?: () => boolean }`
  (флэт-реестр по `id` для MRU). Рендер: `q-item` на каждый узел; если есть `children` — вложенный
  **`q-menu` с `anchor="top end" self="top start"`** (штатный Quasar-паттерн «подменю вбок») +
  иконка-шеврон `chevron_right` справа; лист (`run`) — кликабельный `q-item` с `v-close-popup`;
  `disabled?()` = реактивная блокировка пункта (для «Экспорта» — `!canExportCurrentFile`). Начальная
  модель: `Файл → [Открыть, Экспорт]`, `Настройки` (лист), `Выход` (лист). **Hover-раскрытие**
  (owner req. 8): `q-menu` контейнера — с `no-parent-event`; `@mouseenter` пункта показывает его
  подменю после задержки `SUBMENU_HOVER_DELAY_MS = 120 мс` (и прячет соседние подменю того же уровня),
  `@mouseleave` отменяет таймер; клик по контейнеру раскрывает сразу. Таймер чистится в
  `onBeforeUnmount`.
- **MR-D3. Действия листьев.** `Открыть` → `openFileDialog()`. `Экспорт` → `openExportDialog()`
  (MR-D7). `Настройки` → `goToSettings()` (шорткат Ctrl+P сохраняется без изменений). `Выход` →
  `window.close()` (owner req. 6). Каждый запуск листа проходит через один обёрточный
  `invokeMenuCommand(node)`, который (а) выполняет `node.run()` и (б) пишет `node.id` в MRU (MR-D4).
  Заблокированный (`disabled?()`) лист не запускается и в MRU не пишется.
- **MR-D4. MRU последних 5 команд.** Composable `useMenuMru()` в
  `GnauralCore/ui/composables/use-menu-mru.ts`: реактивный список `ids: string[]`, персист в
  `localStorage` под ключом `mindwave-menu-mru`, `push(id)` = dedup + в начало + обрезка до 5.
  Рендер: `q-separator` после «Выхода», затем строки MRU (label/иконка из флэт-реестра по id);
  клик по строке = тот же `invokeMenuCommand` (сам поднимает пункт наверх MRU). Пустой MRU =
  разделитель и секция **не** отображаются. Узлы-контейнеры (напр. «Файл») в MRU не попадают —
  только листья. `Выход` тоже команда → попадает в MRU по букве требования (флаг: при желании
  владельца исключим позже, чтобы клик по недавнему случайно не закрыл приложение).
- **MR-D5. i18n.** Новые ключи: `audio.menuRoot` («Меню» / "Menu"), `audio.menuExit`
  («Выход» / "Exit"). Переиспользуются: `menuFile` («Файл»), `menuOpen` («Открыть…»), `openSettings`
  («Настройки»). Ключ `editMenu` («Правка») удаляется (требование 5) вместе с его дропдауном.
- **MR-D6. Плейсмент кода.** Разметка меню и `invokeMenuCommand` — в `AudioPage.vue` (там же, где
  меню-бар сейчас). Модель меню — локальный `computed`/const в `AudioPage` (замыкает
  `openFileDialog`/`goToSettings`/`openExportDialog`). MRU — отдельный composable
  (`use-menu-mru.ts`), тестируется юнитом.
- **MR-D7. Экспорт: перенос в меню + диалог (owner req. 7).** Кнопка-дропдаун «Экспорт» удаляется из
  `GnauralTransportControls.vue` (проп `showExport`, оба пункта wav/flac, emit `export`) и три её
  привязки (`:show-export`/`:export-*`/`@export`) в `AudioPage.vue`. Вместо неё — пункт
  `Меню → Файл → Экспорт` (`disabled = !canExportCurrentFile`, только `.gnaural`). По клику
  открывается **диалог экспорта** `ExportDialog` (`q-dialog`): **тип** (радиокнопки/селект wav|flac) +
  **имя файла** (`q-input`, префилл из `buildExportFileName(path, format)`, меняется при смене типа —
  подставляется расширение), кнопки «Отмена»/«Экспорт». По «Экспорту» вызывается существующая
  `downloadSelectedAudio(format)`, но `link.download` берётся из введённого имени (существующая логика
  «сохранить-редактор-перед-мутацией» через `editorPanelRef.prepareForExternalMutation` и обработка
  ошибок сохраняются). Выбор реальной папки сохранения не входит в объём (браузерный `<a download>`
  кладёт в загрузки; можно расширить File System Access API позже — флаг). Новые i18n:
  `audio.exportDialogTitle`, `audio.exportFormat`, `audio.exportFileName`, `audio.exportAction`,
  `audio.exportCancel` (ключи `export`/`exportWav`/`exportFlac`/`exportFailed` переиспользуются/чистятся).

## 4. Фазы

- **Фаза 0** — план + леджер, owner-чекпоинт.
- **Фаза 1** — единый дропдаун «Меню» с data-driven моделью и боковыми подменю: `Файл → [Открыть]`,
  `Настройки`, `Выход`; удаление двух старых дропдаунов «Файл»/«Правка»; i18n `menuRoot`/`menuExit`,
  удаление `editMenu`. (требования 1,2,3,5,6). Без MRU и без Экспорта.
- **Фаза 2** — Экспорт (требование 7): удаление кнопки из тулбара (`GnauralTransportControls` +
  3 привязки), пункт `Файл → Экспорт` (`disabled = !canExportCurrentFile`), диалог `ExportDialog`
  (тип wav/flac + имя файла), `downloadSelectedAudio` с именем из диалога; i18n экспорт-диалога.
- **Фаза 3** — MRU последних 5 команд под разделителем после «Выхода» (требование 4): composable
  `useMenuMru` (localStorage, dedup, max 5) + юнит-тест, запись при каждом запуске листа, повторный
  вызов кликом по недавнему.
- **Фаза 4** — полировка под скриншот (шеврон у пунктов с подменю, hover-раскрытие сбоку, отступы/
  разделители) + ручная проверка в AppCore; owner-чекпоинт.
- **Фаза 5** (owner 2026-07-15, req. 9) — перенос контрола **«Выбранный файл»** (label + дропдаун
  недавних файлов, `.audio-page__meta-strip`, сейчас под таб-баром) в **меню-бар справа от «Меню»**
  (`.audio-page__menubar`). Разметка и логика (`selectedFileLabel`, `audio.recentFiles`,
  `audio.selectPath`, tooltip) переносятся 1:1 — поведение идентично; правки только по размещению и,
  при необходимости, по стилю (выравнивание в flex-строке меню-бара).

## 5. Верификация

- `bun run typecheck` (vue-tsc) + `bun run build` (quasar) в `MindWaveCore/ui` — на каждом шаге.
- `bun test` в `GnauralCore/ui` — существующие тесты зелёные + новый юнит на `useMenuMru`.
- Ручная проверка (dev-браузер): «Меню» открывается; «Файл» раскрывает подменю вбок; «Открыть»
  открывает панель файлов; «Настройки» открывает диалог настроек (Ctrl+P тоже); «Выход» вызывает
  `window.close()`; в тулбаре больше нет кнопки «Экспорт»; «Файл → Экспорт» открывает диалог, выбор
  типа меняет расширение в имени, «Экспорт» скачивает файл с введённым именем, пункт заблокирован для
  не-`.gnaural`; MRU пишется, переживает reload, повторный клик поднимает пункт наверх.
- Фаза 4: ручная проверка в AppCore (AppMain.exe): «Выход» закрывает окно приложения.
