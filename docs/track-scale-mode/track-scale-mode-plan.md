# track-scale-mode — переключатель шкалы «Линейный / Логарифмический» для дорожек

## 1. Требования владельца (дословно)

> Добавь в диалог настроек отображения дорожек перключатиель режима отображения Линейный/Логарифмический

Уточнения (AskUserQuestion, 2026-07-18):

1. **Место** — панель **«Список треков»** (`TrackListView`), рядом с уже существующим переключателем
   «Перенос точек» (`pointDragMode`). Один **глобальный** переключатель на все дорожки.
2. **Метод** — оформить по Plan+Ledger (этот леджер).

## 2. Область применения

Лог/линейная шкала осмысленна только для оси **базовой частоты** (`mode === 'base'`):

- `volume` — фиксированная линейная ось `0..1`;
- `balance` — фиксированная `-1..1` (L/C/R);
- `beat` — линейный автодиапазон (маленькие 0..N Гц).

Сейчас ось базовой частоты авто-выбирает `log` (как классический редактор расписания) либо `symlog`,
если данные достигают 0 ([gtrack-render.ts:283-319](../../../GnauralCore/ui/composables/gtrack-render.ts#L283)).
Переключатель даёт владельцу **принудительно** выбрать линейную ось базовой частоты.

## 3. Решения

- **TS-D1. Форма и место.** Глобальный `q-btn-toggle` в секции «свойства редактора» панели «Список
  треков» (`TrackListView`), под тумблером «Перенос точек» — та же форма, что у `pointDragMode`
  (`snapshot`/`action`, а не локальный ref), gnaural-only (`v-if snapshot.isGnaural`). Прецедент —
  тумблер «Шкала» в `GnauralScheduleView`. Обоснование: выбор владельца (глобально, «Список треков»).

- **TS-D2. Тип и значение по умолчанию.** `GTrackBaseScale = 'log' | 'linear'`, дефолт `'log'` =
  текущее поведение (никакой визуальной регрессии). Персист в `localStorage`
  (`mindwave-gtrack-base-scale`), ровно как `pointDragMode` — глобальная editor-настройка, не пер-дорожка,
  не в модели расписания.

- **TS-D3. Только базовая частота.** Переключатель влияет лишь на дорожки `mode === 'base'`.
  `'linear'` строит обычную линейную ось поверх диапазона данных (та же логика паддинга/headroom, что
  у линейной оси бита — фактор общий хелпер `linearAutoAxis`). `'log'` = текущее авто (log или symlog).
  Громкость/баланс/бит переключатель не трогает. Симлог при `'linear'` не нужен: линейная ось
  представляет 0 напрямую.

- **TS-D4. Проводка override.** `gtrackAxis(...)` получает 5-й необязательный параметр
  `baseScale: GTrackBaseScale = 'log'` (обратно совместимо). `GTrackView` получает проп
  `baseScaleMode` и прокидывает его в `gtrackAxis`. `TracksPanel` передаёт
  `gtracks.baseScaleMode.value`. Панель «Список треков» ходит через `TrackListSnapshot.baseScaleMode`
  + `TrackListAction { kind: 'set-base-scale-mode' }` → `applyTrackListAction` → `gtracks.setBaseScaleMode`
  (тот же контракт, что `set-point-drag-mode`; работает и для откреплённого окна через мост).

- **TS-D5. i18n.** Новые ключи рядом с `gtrackDragMode*`: `gtrackBaseScale` (подпись),
  `gtrackBaseScale_log`, `gtrackBaseScale_linear`. (Существующие `scheduleScaleLog/Linear` не
  переиспользуем как значения — держим gtrack-скоуп параллельно `gtrackDragMode_*`.)

## 4. Шаги (по фазам)

- **Фаза 1 — ядро/persist**
  - TS1.1 `gtrack-render.ts`: тип `GTrackBaseScale`; хелпер `linearAutoAxis(lo, hi, editable)`
    (вынести из ветки beat); 5-й параметр `baseScale` в `gtrackAxis`; линейная ветка базовой оси;
    юнит-тесты.
  - TS1.2 `use-gtrack-lanes.ts`: персист-ref `baseScaleMode` + `setBaseScaleMode` (зеркало
    `pointDragMode`), экспорт из композабла.

- **Фаза 2 — контракт панели + проводка рендера**
  - TS2.1 `track-list-model.ts` (+ `baseScaleMode` в snapshot, `set-base-scale-mode` в action),
    `use-track-list-snapshot.ts`, `track-list-actions.ts` (+ `setBaseScaleMode` в API и case) и его
    тест.
  - TS2.2 `GTrackView.vue` (проп `baseScaleMode` → `gtrackAxis`) + `TracksPanel.vue`
    (`:base-scale-mode="gtracks.baseScaleMode.value"`).
  - TS2.3 `TrackListView.vue`: `q-btn-toggle` в секции свойств редактора + i18n ключи (ru/en).

- **Фаза 3 — верификация**
  - TS3.1 `bun test ui server`, `bun run typecheck`, `bun run build`.
  - TS3.2 **PAUSE**: владелец гоняет реальное приложение — тумблер в «Списке треков», базовая дорожка
    перерисовывается лог↔лин, выбор переживает перезагрузку.

## 5. Риски

- CRLF vs LF: проверять EOL каждого файла перед правкой (composables — LF, компоненты/i18n — CRLF).
- Мост откреплённого окна: `snapshot`/`action` пересекают BroadcastChannel — новые поля прозрачны,
  обе стороны из одной сборки.
- Тест-дубль `track-list-actions.test.ts` строит полный `TrackListGtracksApi` — добавить
  `setBaseScaleMode` в дубль и кейс.

## 6. Верификация

`GnauralCore`: `bun test ui server`. `MindWaveCore/ui`: `bun run typecheck` (vue-tsc покрывает
GnauralCore по алиасу) + `bun run build`. Финал — реальное приложение (TS3.2).
