import en from './locales/en.json'
import ru from './locales/ru.json'
import { registeredModules, type LocaleMessages, type MessageTree } from '../modules'

type MutableMessageTree = Record<string, unknown>

function isMessageTree(value: unknown): value is MutableMessageTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeMessageTrees(target: MutableMessageTree, source: MessageTree): MutableMessageTree {
  const result: MutableMessageTree = { ...target }

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key]
    result[key] = isMessageTree(targetValue) && isMessageTree(sourceValue)
      ? mergeMessageTrees(targetValue, sourceValue)
      : sourceValue
  }

  return result
}

function mergeLocaleMessages(...bundles: readonly LocaleMessages[]): LocaleMessages {
  const result: Record<string, MutableMessageTree> = {}

  for (const bundle of bundles) {
    for (const [locale, messages] of Object.entries(bundle)) {
      result[locale] = result[locale] === undefined
        ? { ...messages }
        : mergeMessageTrees(result[locale], messages)
    }
  }

  return result as LocaleMessages
}

const moduleMessages = registeredModules.map((module) => module.messages)

const hostMessages: LocaleMessages = { en, ru }

export default mergeLocaleMessages(hostMessages, ...moduleMessages)
