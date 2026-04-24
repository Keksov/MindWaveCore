import { boot } from 'quasar/wrappers'
import { createI18n } from 'vue-i18n'
import messages from 'src/i18n'

export default boot(({ app }) => {
  const savedLocale = localStorage.getItem('mindwave-locale') ?? 'ru'

  const i18n = createI18n({
    locale: savedLocale,
    fallbackLocale: 'en',
    legacy: false,
    messages
  })

  app.use(i18n)
})
