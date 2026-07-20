# synth-parallel-render — многопоточный offline-синтез Gnaural.exe

**Owner request (2026-07-20):** после профилирования генерации владелец выбрал (AskUserQuestion)
**«Многопоточность синтеза»** — распараллелить синтез-цикл рендера, самый дорогой этап генерации
больших расписаний.

**Контекст (из профиля пред. сессии):** рендер `Gnaural.exe` = parse 0 мс + PCM-load 234 мс +
**синтез `fillBuffer` 23 734 мс (98%)** + запись WAV 375 мс (ForestMeditation, 1500 с, 31 голос,
~2 млрд голос-сэмплов). Персистентный кеш [wave-spectrum-cache](../wave-spectrum-cache/wave-spectrum-cache-plan.md)
уже убрал **повторные** open'ы (WAV/тайлы — хиты с диска); ускорение синтеза бьёт по **cache-miss**:
первый open, после правки содержимого, новый solo-набор. Оси ортогональны.

Ledger (authoritative): [synth-parallel-render-progress.json](synth-parallel-render-progress.json).
Методология — Plan + Ledger: атомарные покоммитные шаги `PS1.1 …`, `verify` перед `done`,
`validate-ledger.js` перед docs-коммитом, **на PAUSE останавливаемся и спрашиваем владельца**.

---

## 1. Требования
1. Ускорить **генерацию** (offline-синтез WAV) больших расписаний за счёт многопоточности.
2. Не изменить **выход** (бит-в-бит) и не сломать **realtime**-воспроизведение.

## 2. Verified premises (чтение кода 2026-07-20)
- Голоса взаимодействуют **только** в финальном суммировании `sumL += sample*volL; sumR += …`
  ([GnauralSynth.pas:634-635](../../../GnauralCore/cli/core/GnauralSynth.pas#L634-L635)); в остальном
  независимы — состояние per-voice в `FvoiceStates[v]` (фазы `FsinPosL/R`, `FpcmPos`, `FcurEntry`, …).
- Общее **глобальное** состояние только у двух типов: pink noise → глобальный `bbRand`
  ([:560-561](../../../GnauralCore/cli/core/GnauralSynth.pas#L560-L561)); water/rain → общие
  «mother»-буферы `getDropMother`/`getRainMother` ([:521](../../../GnauralCore/cli/core/GnauralSynth.pas#L521)/[:531](../../../GnauralCore/cli/core/GnauralSynth.pas#L531)).
  Binaural / PCM / iso(Alt) — чисто per-voice. ForestMeditation = 1 binaural + 30 PCM → безопасное множество.
- Offline-путь = [TWavWriter.renderToFile](../../../GnauralCore/cli/core/GnauralWavWriter.pas) (WAV) /
  `writeSynthToSndfile` (FLAC) — крутят `fillBuffer` в цикле. Realtime = `fillBuffer` из PortAudio callback.
- `Gnaural.exe` — единственная копия `GnauralCore/cli/build/x64` (бандл-шэдоу нет, в отличие от
  SpectrumCore-воркера); резолв `resolveGnauralExecutablePath` / env `GNAURAL_EXE`.
- FPC bundled (VendorsCore) содержит `fpThreadPool`, `Classes.TThread`, `SyncObjs`.

## 3. Решения
- **PS-D1.** Ось параллелизма — **по голосам** (voice-parallel), блочно. Время параллелить нельзя:
  посэмпловые фазовые аккумуляторы / PCM-позиция / entry-walk строго последовательны. Блок из `B`
  фреймов: `T` потоков синтезируют свои голоса в приватные accum-буферы, барьер, координатор
  суммирует → мастер-гейн → клип → int16 → пишет. Память ограничена блоком (`B×2×4×T`).
- **PS-D2.** Правим **только offline**-путь. Realtime `fillBuffer` не трогаем (накладные потоков на
  4096-блоке callback'а не окупятся, у rt свои ограничения). Следствие: DSP одного голоса за блок
  выносим в **переиспользуемую** функцию, которую зовут и single-thread `fillBuffer`, и параллельный
  рендерер — чтобы синтез-логика не разошлась (единственный источник истины).
- **PS-D3.** Безопасное к параллели множество = binaural / PCM / iso / isoAlt (per-voice). Небезопасные
  (pink noise → `bbRand`; water/rain → общие mother) исполняются на **координаторе** (main), не в пуле.
  ForestMeditation параллелится целиком; noise/rain-планы получают частичный параллелизм. Альтернатива
  (per-voice RNG для шума + доказать read-only mother) — будущее уточнение (Q1).
- **PS-D4.** **Бит-в-бит** идентичный выход vs текущий single-thread — железный критерий. Достигается
  фиксированным порядком суммирования голосов (по индексу, а не по порядку завершения потоков) и тем,
  что извлечённая функция (PS-D2) — та же арифметика. Тест: фикстур-расписание рендерится 1-поток и
  N-поток → **идентичные байты WAV**.
- **PS-D5.** Число потоков = авто (`CPUCount-1`, клэмп ≥1), override env `GNAURAL_RENDER_THREADS`
  (`1` = точный старый путь) — для тестов, детерминизма и аварийной деградации.
- **PS-D6.** Пересборка `Gnaural.exe` (`build_x64.bat`); бандл-шэдоу нет → обновляем только `build/x64`.
  Проверить realtime-регресс (воспроизведение играет корректно). Бэкенд без консоли — лог в `var/*.log`
  при необходимости (память [bun-watch-ignores-cross-repo-server], [gnaural-exe-is-ours-rebuild-it]).

## 4. Фазы и шаги
Граф `dependsOn` + ацикличность — в леджере.

**Фаза 0** — `PS0.1` план + леджер + verified premises.

**Фаза 1 — рефактор без смены поведения (де-риск):**
`PS1.1` вынести per-voice block-synth из `fillBuffer` в переиспользуемую процедуру (позиция сэмпла и
фаза periodic-update — **входные параметры**, а не общие мутабельные поля); single-thread `fillBuffer`
и offline-writer зовут её; добавить бит-в-бит фикстур-тест (выход WAV не изменился vs baseline).

**Фаза 2 — параллельный offline-рендерер:**
`PS2.1` пул потоков + партиция безопасных голосов + приватные accum-буферы + барьер на блок +
детерминированное суммирование; небезопасные голоса (noise/water) — на координаторе (PS-D3).
`PS2.2` бит-в-бит верификация (1 vs N поток на фикстуре) + замер ускорения (прямой прогон `-o`,
prof-скрипты) на ForestMeditation.

**Фаза 3 — подключение и приёмка:**
`PS3.1` `renderToFile`/`writeSynthToSndfile` используют параллельный рендерер + knob потоков (PS-D5);
пересборка exe. **`PS3.2` PAUSE** — владелец на реальном приложении: холодный open ForestMeditation
заметно быстрее (замер), волна/спектр и воспроизведение корректны.

## 5. Риски
- **R1** детерминизм суммирования — фиксированный порядок голосов (PS-D4).
- **R2** небезопасные голоса (noise `bbRand` / water mother) — на координаторе (PS-D3).
- **R3** realtime не трогаем — переиспользуем извлечённую функцию (PS-D2); отдельно проверить playback.
- **R4** FPC-конкурентность — каждый поток пишет только свой accum-буфер и состояние своих голосов;
  барьер на границе блока; общие данные (schedule, PCM-данные голоса) — read-only во время синтеза.
- **R5** память = `B×2×4×T` — ограничено выбором `B` (Q2).
- **R6** loop-wrap — offline обычно single-loop (`<loops>1`), многолуп детерминирован per-voice.
- **R7** Amdahl — непараллельная часть (суммирование + запись + PCM-load + noise/water) мала; замерить
  реальный спидап (PS2.2), не обещать линейность вслепую.
- **R8** пересборка exe; realtime playback sanity перед PAUSE.

## 6. Verify
- `GnauralCore` — `bun test ui server` + новый бит-в-бит фикстур-тест (1 vs N поток → одинаковый WAV).
- Прямой прогон `Gnaural.exe <file> -o out.wav` (prof-скрипты в scratchpad) — замер синтеза до/после,
  при `GNAURAL_RENDER_THREADS=1` и авто.
- Пересборка `build_x64.bat`; playback sanity; `validate-ledger.js` перед docs-коммитом.
- **Реальное приложение** (PS3.2): холодный open ForestMeditation — время до появления графиков.

## 7. Открытые вопросы
- **Q1** — небезопасные голоса: координатор (PS-D3 default) сейчас, или сразу per-voice-RNG для шума +
  доказать read-only mother? Default — координатор (проще; ForestMeditation не затронут).
- **Q2** — размер блока `B` (амортизация барьера vs память/латентность). Default — подобрать в PS2.1
  (ориентир 16k–64k фреймов).
