import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export interface PreparedSleepDrowseSchedule {
  readonly filePath: string
  readonly rootPath: string
}

const BASE_SCHEDULE_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "BodyMonitorCore",
  "server",
  "etc",
  "sleep-drowse.gnaural",
)

const GENERATED_SCHEDULE_DIR = resolve(import.meta.dir, "tmp", "sleep-drowse")

const normalizeDurationMin = (aDurationMin: number): number => {
  return Number.isInteger(aDurationMin) && aDurationMin > 0 ? aDurationMin : 1
}

export const getSleepDrowseSchedulePath = (): string => {
  return BASE_SCHEDULE_PATH
}

const replaceLoopCount = (aContent: string, aLoopCount: number): string => {
  const nextContent = aContent.replace(/<loops>\s*\d+\s*<\/loops>/i, `<loops>${aLoopCount}</loops>`)
  if (nextContent === aContent) {
    throw new Error("Sleep drowse schedule is missing a <loops> element")
  }

  return nextContent
}

export const prepareSleepDrowseSchedule = async (
  aDurationMin: number,
): Promise<PreparedSleepDrowseSchedule> => {
  const durationMin = normalizeDurationMin(aDurationMin)
  if (durationMin === 1) {
    return {
      filePath: BASE_SCHEDULE_PATH,
      rootPath: dirname(BASE_SCHEDULE_PATH),
    }
  }

  const baseContent = await readFile(BASE_SCHEDULE_PATH, "utf8")
  const nextContent = replaceLoopCount(baseContent, durationMin)

  await mkdir(GENERATED_SCHEDULE_DIR, { recursive: true })

  const generatedFilePath = resolve(GENERATED_SCHEDULE_DIR, `sleep-drowse-${durationMin}m.gnaural`)
  await writeFile(generatedFilePath, nextContent, "utf8")

  return {
    filePath: generatedFilePath,
    rootPath: GENERATED_SCHEDULE_DIR,
  }
}
