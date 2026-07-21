import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import { createRouter, createWebHistory } from 'vue-router'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'

import moment from 'moment'
import Menu from './components/Menu.vue'
import App from './App.vue'

export const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', redirect: '/analysis/1/menu' },
        { path: '/analysis/:doc/menu', component: Menu },
    ],
})

export const vuetify = createVuetify({ components, directives })

export { App }

// Real bootstrap only — skipped under Vitest (import.meta.env.MODE ===
// "test" there by default), so tests can import App/router above and mount
// them however the test needs without this module also mounting a second,
// untestable instance into a real "#app" element as a side effect of the
// import itself.
if (import.meta.env.MODE !== 'test') {
    const app = createApp(App)

    app.config.globalProperties.$moment = {
        dateFormat(date) {
            return moment(date).format('yyyy-MM-DD')
        },
    }

    app.use(router)
    app.use(vuetify)
    app.mount('#app')
}
