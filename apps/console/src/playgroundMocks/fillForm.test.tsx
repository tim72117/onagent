// Mirrors clickButton.test.tsx's structure and approach for the "fill_form"
// template mock (see ./fillForm.tsx's useFillFormMock) — full end-to-end
// through ../Playground (WS handshake, tool_call dispatch, tool_result),
// not a unit test of the hook in isolation, so a regression here would
// also catch handleToolMessage's dispatch wiring breaking.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Playground } from '../Playground'
import type { Tool } from '../schema'

// See clickButton.test.tsx for why this fake exists (jsdom has no real WS
// server) and what each helper does.
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  static readonly CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  sent: unknown[] = []
  url: string
  private listeners: Record<string, ((event: any) => void)[]> = {}

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, handler: (event: any) => void) {
    ;(this.listeners[type] ??= []).push(handler)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.listeners.open?.forEach((h) => h({}))
  }

  emitMessage(envelope: unknown) {
    this.listeners.message?.forEach((h) => h({ data: JSON.stringify(envelope) }))
  }

  lastSent(type: string): any {
    return [...this.sent].reverse().find((e: any) => e.type === type)
  }
}

function makeFillFormTool(name = 'fill_form', fieldEnum?: string[]): Tool {
  return {
    name,
    description: 'Fill a specific form field with a value.',
    parameters: {
      type: 'object',
      properties: { field: { type: 'string', ...(fieldEnum ? { enum: fieldEnum } : {}) }, value: { type: 'string' } },
      required: ['field', 'value'],
    },
    sourceTemplate: 'fill_form',
  }
}

describe('Playground fill_form mock', () => {
  let ws: FakeWebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    Element.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  async function renderConnected(tools: Tool[]) {
    render(<Playground appId="test-app" tools={tools} />)
    ws = FakeWebSocket.instances[0]
    await act(async () => {
      ws.emitOpen()
    })
    await act(async () => {
      ws.emitMessage({ type: 'ack', payload: { sessionId: 's1', toolNames: tools.map((t) => t.name) } })
    })
  }

  it('renders exactly the two fixed mock fields when a fill_form tool exists', async () => {
    await renderConnected([makeFillFormTool()])
    expect(screen.getByText('item')).toBeTruthy()
    expect(screen.getByText('description')).toBeTruthy()
  })

  it('renders no mock fields when no fill_form-template tool exists', async () => {
    await renderConnected([])
    expect(screen.queryByText('item')).toBeNull()
  })

  it('renders one input per option in the tool field parameter enum, instead of the default set', async () => {
    await renderConnected([makeFillFormTool('fill_form', ['name', 'email', 'phone'])])
    expect(screen.getByText('name')).toBeTruthy()
    expect(screen.getByText('email')).toBeTruthy()
    expect(screen.getByText('phone')).toBeTruthy()
    expect(screen.queryByText('item')).toBeNull()
  })

  it('a tool_call naming a known field writes the value into the mock input and reports genuine ok:true', async () => {
    await renderConnected([makeFillFormTool()])

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'fill_form', args: { field: 'item', value: 'Widget' } },
      })
    })

    const input = screen.getByDisplayValue('Widget') as HTMLInputElement
    expect(input).toBeTruthy()

    const result = ws.lastSent('tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      requestId: 'r1',
      payload: {
        toolName: 'fill_form',
        ok: true,
        result: { message: '"item" now contains "Widget"', field: 'item', value: 'Widget' },
      },
    })
  })

  it('a filled value persists — no timer clears it', async () => {
    vi.useFakeTimers()
    await renderConnected([makeFillFormTool()])
    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'fill_form', args: { field: 'item', value: 'Widget' } },
      })
    })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByDisplayValue('Widget')).toBeTruthy()
    vi.useRealTimers()
  })

  it('a tool_call naming an unknown field reports honest ok:false listing available fields', async () => {
    await renderConnected([makeFillFormTool()])

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'fill_form', args: { field: 'phone', value: '0912' } },
      })
    })

    const result = ws.lastSent('tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      requestId: 'r1',
      payload: {
        toolName: 'fill_form',
        ok: false,
        error: 'no mock form field named "phone" in Playground (available: item, description)',
      },
    })
  })

  it('a tool_call with a non-string value reports ok:false naming the type, not a fabricated field-not-found error', async () => {
    await renderConnected([makeFillFormTool()])

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'fill_form', args: { field: 'item', value: 42 } },
      })
    })

    const result = ws.lastSent('tool_result')
    expect(result.payload).toEqual({
      toolName: 'fill_form',
      ok: false,
      error: "fill_form's value must be a string; got number",
    })
  })

  it('a human typing into a mock field sends no WebSocket message', async () => {
    await renderConnected([makeFillFormTool()])
    const before = ws.sent.length

    const input = screen.getByLabelText('item') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Gadget' } })

    expect(screen.getByDisplayValue('Gadget')).toBeTruthy()
    expect(ws.sent.length).toBe(before)
  })

  it('a human-typed value is overwritten when the agent later fills the same field (one shared effect)', async () => {
    await renderConnected([makeFillFormTool()])

    const input = screen.getByLabelText('item') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Human typed' } })
    expect(screen.getByDisplayValue('Human typed')).toBeTruthy()

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'fill_form', args: { field: 'item', value: 'Agent typed' } },
      })
    })

    expect(screen.getByDisplayValue('Agent typed')).toBeTruthy()
  })

  it('click_button and fill_form tools can coexist, each with independent state', async () => {
    const clickTool: Tool = {
      name: 'click_button',
      description: 'Click a button on the page, identified by its visible label.',
      parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      sourceTemplate: 'click_button',
    }
    await renderConnected([clickTool, makeFillFormTool()])

    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
    expect(screen.getByText('item')).toBeTruthy()

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'fill_form', args: { field: 'item', value: 'Widget' } },
      })
    })
    expect(screen.getByRole('button', { name: 'Confirm' }).className).not.toContain('mockButtonClicked')
    expect(screen.getByDisplayValue('Widget')).toBeTruthy()
  })
})
