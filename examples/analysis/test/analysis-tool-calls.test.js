// Integration test: does a tool_call/tool_query arriving over the
// WebSocket actually reach the real analysis handlers (dev.js's
// select_question/list_questions) and produce the right observable effect
// (Menu.vue's selection state, or the tool_result sent back)?
//
// Only the transport is faked (MockWebSocket, installed as
// globalThis.WebSocket) — AgentBridge (packages/bridge) and App/Menu.vue
// (dev.js/components/Menu.vue) are the real, unmodified code. A message is
// injected by firing MockWebSocket's "message" event, exactly how a real
// server response would arrive, rather than calling any internal method
// that would bypass what's actually being tested.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { App, router, vuetify } from '../dev.js'
import Menu from '../components/Menu.vue'
import { questions } from '../data/questions.js'
import { MockWebSocket } from './mock-websocket.js'

let wrapper
let ws

beforeEach(async () => {
    MockWebSocket.instances.length = 0
    globalThis.WebSocket = MockWebSocket

    router.push('/analysis/1/menu')
    await router.isReady()

    wrapper = mount(App, {
        global: { plugins: [router, vuetify] },
    })
    await flushPromises()

    ws = MockWebSocket.instances.at(-1)
    ws.simulateOpen()
    ws.simulateMessage({
        type: 'ack',
        payload: { sessionId: 'test-session', toolNames: ['select_question', 'list_questions'] },
    })
    await flushPromises()
})

afterEach(() => {
    wrapper.unmount()
})

function menuVm() {
    return wrapper.findComponent(Menu).vm
}

// Two real question names from data/questions.js (a snapshot of the mock
// backend's actual seeded survey data — see that file's header comment).
// Referenced by name, not by array index, on purpose: this snapshot could
// be re-fetched/reordered later, and these two specific names are what the
// tests below actually depend on staying present.
const [Q1, Q2] = [questions[0].name, questions[1].name]

describe('select_question tool_call (action kind)', () => {
    it('selects the named question when selected=true', async () => {
        expect(menuVm().selected).toEqual([])

        ws.simulateMessage({
            type: 'tool_call',
            requestId: 'r1',
            payload: { toolName: 'select_question', args: { names: [Q1], selected: true } },
        })
        await flushPromises()

        expect(menuVm().selected.map((q) => q.name)).toEqual([Q1])
    })

    it('deselects the named question when selected=false', async () => {
        ws.simulateMessage({
            type: 'tool_call',
            requestId: 'r1',
            payload: { toolName: 'select_question', args: { names: [Q1, Q2], selected: true } },
        })
        await flushPromises()
        expect(menuVm().selected.map((q) => q.name).sort()).toEqual([Q1, Q2].sort())

        ws.simulateMessage({
            type: 'tool_call',
            requestId: 'r2',
            payload: { toolName: 'select_question', args: { names: [Q1], selected: false } },
        })
        await flushPromises()

        expect(menuVm().selected.map((q) => q.name)).toEqual([Q2])
    })

    it('clears the whole selection when clear=true, ignoring names/selected', async () => {
        ws.simulateMessage({
            type: 'tool_call',
            requestId: 'r1',
            payload: { toolName: 'select_question', args: { names: [Q1, Q2], selected: true } },
        })
        await flushPromises()
        expect(menuVm().selected.length).toBe(2)

        ws.simulateMessage({
            type: 'tool_call',
            requestId: 'r2',
            payload: { toolName: 'select_question', args: { clear: true } },
        })
        await flushPromises()

        expect(menuVm().selected).toEqual([])
    })

    it('sends an ok tool_result back regardless (the SDK always answers; only the backend treats action-kind tools as fire-and-forget)', async () => {
        ws.simulateMessage({
            type: 'tool_call',
            requestId: 'r1',
            payload: { toolName: 'select_question', args: { names: [Q1], selected: true } },
        })
        await flushPromises()

        const result = ws.sentEnvelopes().find((e) => e.type === 'tool_result' && e.requestId === 'r1')
        expect(result.payload).toEqual({ toolName: 'select_question', ok: true, result: null })
    })
})

describe('list_questions tool_query (query kind)', () => {
    it('answers with the real question list via a tool_result', async () => {
        ws.simulateMessage({
            type: 'tool_query',
            requestId: 'r1',
            payload: { toolName: 'list_questions', args: { limit: questions.length } },
        })
        await flushPromises()

        const result = ws.sentEnvelopes().find((e) => e.type === 'tool_result' && e.requestId === 'r1')
        expect(result).toBeDefined()
        expect(result.payload.ok).toBe(true)
        expect(result.payload.result).toEqual(questions.map((q) => ({ name: q.name, title: q.title })))
    })

    it('respects the limit argument', async () => {
        ws.simulateMessage({
            type: 'tool_query',
            requestId: 'r1',
            payload: { toolName: 'list_questions', args: { limit: 2 } },
        })
        await flushPromises()

        const result = ws.sentEnvelopes().find((e) => e.type === 'tool_result' && e.requestId === 'r1')
        expect(result.payload.result).toHaveLength(2)
    })
})

describe('unregistered tool name', () => {
    it('reports failure instead of silently doing nothing', async () => {
        ws.simulateMessage({
            type: 'tool_call',
            requestId: 'r1',
            payload: { toolName: 'delete_everything', args: {} },
        })
        await flushPromises()

        const result = ws.sentEnvelopes().find((e) => e.type === 'tool_result' && e.requestId === 'r1')
        expect(result.payload.ok).toBe(false)
        expect(result.payload.error).toMatch(/no handler registered/)
    })
})
