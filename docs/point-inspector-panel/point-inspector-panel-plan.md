# point-inspector-panel — план

Рефакторинг диалога **«Параметры точки»** на стандартный механизм детачбл/докабл панели
(`@panel/PanelWindow`).

## 1. Требования владельца (дословно)

1. > «Рефакторинг диалога "Параметры точки". Этот диалог должен использовать наш стандартный
>    механизм детачбл/докабл панели.»

### Уточнения (квиз owner, 2026-07-22)

2. **Стадирование detach:** «Сначала float/dock, detach — фаза-PAUSE потом.»
3. **Режимы:** «Оба режима в панель» (single «Параметры точки» + table bulk-редактор).
4. **Позиционирование:** «Стандартная геометрия панели» (persisted floatRect, без привязки к точке).

## 2. Что есть сейчас

- Диалог — **не** `QDialog`, а бespoke НЕмодальный перетаскиваемый `<aside role="dialog"
  aria-modal="false">`, встроенный прямо в
  [TracksPanel.vue](../../../GnauralCore/ui/components/TracksPanel.vue) (шаблон ~строки 1000–1214,
  логика ~1438–1706). Специально **без backdrop** — канвас треков остаётся интерактивным. Титул-бар
  сам является drag-ручкой (`onInspectorDrag*`, `:style="inspectorStyle"`).
- Два режима через `inspectorMode` (`'single' | 'table' | 'none'`):
  - **single** — форма одной точки: Время (с), Базовая частота (Гц), Частота биения (Гц) `= beatFreqHalf*2`,
    Громкость L, Громкость R, производные Громкость + Баланс (слайдер, скрыт для mono-голоса), автосейв,
    кнопки Apply / Удалить узел / Добавить узел→вправо / undo-redo.
  - **table** — bulk-редактор `q-markup-table` при выделении 2+ вершин.
- Модель — `GTrackPoint { id, timeSec, baseFreq, beatFreqHalf, volL, volR }`
  ([gtrack-model.ts](../../../GnauralCore/ui/composables/gtrack-model.ts)). Сохранение —
  `gtracks.applyPointEdit(ref, patch)` → `m.edit(…, 'point-edit')` (одна единица undo), автосейв на
  blur/enter/release или кнопка Apply.
- Открытие: `GTrackView @edit-point` → `openPointDialog(...)` (отказ для locked preparse/generator
  голосов с предложением фикса). Закрытие: `closeInspector()`.
- Состояние живёт **в памяти** (`useSharedGtrackLanes`, PW5.6a), редактируется с undo.

## 3. Целевой механизм

`@panel/PanelWindow.vue` + `usePanelWindowState(panelId, opts)`
([MindWaveCore/ui/src/components/panel/](../../ui/src/components/panel/), alias `@panel`). Контрол
**готов** (feature panel-window `done`), уже несёт 5 потребителей и generic по `bridgeState`+`events[]`
(чек-лист репликации PW5.7). Обвязка окна (титул, drag, dock-меню на 6 режимов, close, resize,
detached-жизненный цикл) — внутри контрола; потребитель рендерит только контент через слоты
default/`#footer`/`#titlebar-actions`.

Ближайший прецедент — **track-list** (PW5.6c/PW5.7): панель на in-memory gtracks, float/dock даётся
дёшево, а detached-окно потребовало remote-control редизайна, т.к. дочернее окно — отдельный JS-realm
без загруженного файла (PW-D11). «Параметры точки» — тот же случай.

## 4. Решения

- **PI-D1** — механизм = `@panel/PanelWindow` + `usePanelWindowState('point-inspector')`; инфраструктура
  `@panel` для float/dock не меняется.
- **PI-D2** — detach отдельной **PAUSE-фазой** (Фаза 3), не в Фазе 2 (owner). Причина: дочернее окно —
  отдельный JS-realm без загруженного файла, наивный ремоунт = пустой инспектор + клоббер per-file
  ключей (PW-D11).
- **PI-D3** — **оба режима** в одну панель; `:title` переключается по `inspectorMode`
  (single→`gtrackPointDialog`, table→заголовок bulk-режима, none→`gtrackPointDialog`). `inspectorMode`
  управляет содержимым, не видимостью (см. PI-D7).
- **PI-D4** — **стандартная геометрия**: убрать открытие у точки и собственный drag; persisted floatRect
  под `mindwave-panel-point-inspector-*`.
- **PI-D5** *(под сверку на PAUSE PI0.2)* — хостить на уровне **AudioPage** в общем dock-wrap рядом с
  file-open/track-list, на **общем singleton-состоянии**, а не внутри TracksPanel. Причины: (a) вкладки
  player-view без keep-alive — TracksPanel умирает на смене вкладки (PW-D10); (b) единообразие с
  track-list; (c) Фаза 3 требует AudioPage-хостируемый контент + authoritative общее состояние, поэтому
  делаем сразу и не повторяем revert-churn PW5.2→PW5.6. **Enabler:** состояние инспектора поднимается в
  композабл над `useSharedGtrackLanes`. *Альтернатива (veto): хост внутри TracksPanel — меньше кода в
  Фазе 2, но known-bad PW5.2-паттерн и перенос в Фазе 3.*
- **PI-D6** — verify: `bun run typecheck`+`build` (MindWaveCore/ui), `bun test ui server` (GnauralCore),
  `validate-ledger.js` перед docs-коммитом; композабл Pinia-free при создании (useAudioStore в момент
  вызова, как PW5.6b); мульти-репо коммиты раздельно.
- **PI-D7** *(owner 2026-07-22)* — **развязать `panel.open` от выделения** (IDE properties-panel).
  `panel.open` управляется пользователем (тумблер в тулбаре TracksPanel + close панели), не выделением.
  Содержимое: 1 вершина→форма, 2+→таблица, 0→плейсхолдер «выберите точку» (панель остаётся в доке).
  `@edit-point` авто-открывает панель, если закрыта. Тумблер виден только в gnaural-редакторе (не
  un-gated). `closeInspector` больше не трогает `panel.open`.

## 5. Фазы и шаги

- **Фаза 0 — Планирование.** PI0.1 план+леджер · **PI0.2 PAUSE** (сверка решений, особенно PI-D5/PI-D2).
- **Фаза 1 — Общее состояние.** PI1.1 поднять состояние инспектора в `use-point-inspector.ts` над
  `useSharedGtrackLanes`; TracksPanel делегирует edit-point/add-point; старый `<aside>` временно на общем
  состоянии (приложение живо на каждом коммите).
- **Фаза 2 — PanelWindow (float/dock).** PI2.1 `PointInspectorPanel.vue` (форма/таблица/плейсхолдер, без chrome) ·
  PI2.2 стор `point-inspector-panel.ts` · PI2.3 `PointInspectorDialog.vue` (PanelWindow
  `:allow-detach=false`) в dock-wrap AudioPage + тумблер в тулбаре · PI2.4 удалить старый `<aside>`/drag ·
  PI2.5 живая проверка · **PI2.6 PAUSE** (приёмка + greenlight Фазы 3).
- **Фаза 3 — Detach (remote-control), gated.** PI3.1 snapshot+actions · PI3.2 pure view + in-window +
  remote-адаптер + регистрация в `module.ts` · PI3.3 parent action applier + `:bridge-state` +
  allowDetach=true · PI3.4 живая проверка detached · **PI3.5 PAUSE** (приёмка).

## 6. Риски

- **PW-D11 клоббер / пустой инспектор в detached** — снимается только remote-control (Фаза 3), поэтому в
  Фазе 2 строго `:allow-detach="false"` (явно, не по отсутствию — PW-D12: absent Boolean prop → `false`).
- **Подъём состояния (PI1.1)** — самый крупный кусок; много поведения (autosave, delete/add-node,
  undo-with-focus, mono/balance, fix-prompt). Держать один undo-юнит и Pinia-free создание.
- **Потеря привязки к точке** — принято owner (PI-D4); floatRect персистится.
- **Мульти-репо** — код в GnauralCore, леджер в MindWaveCore/docs; ставить только свои файлы.

## 7. Verify

- `bun run typecheck` + `bun run build` в `MindWaveCore/ui`.
- `bun test ui server` в `GnauralCore` (юнит-тесты композабла).
- `validate-ledger.js` перед каждым `docs(point-inspector-panel)`-коммитом.
- Приоритет — прогон в реальном приложении (float/4 дока/оба режима; в Фазе 3 — два окна + AppCore).
