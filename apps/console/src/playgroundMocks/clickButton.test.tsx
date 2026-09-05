// Written before the playgroundMocks/ architecture refactor to lock down
// click_button's exact behavior — message strings, timing, and the WS wire
// protocol it produces — through the full ../Playground component
// end-to-end (WS handshake, tool_call dispatch, tool_result). It survived
// the refactor unmodified and all assertions still passed, confirming the
// migration into useClickButtonMock (./clickButton.tsx) didn't change
// behavior. Kept here as the ongoing regression test for this template's
// mock; see fillForm.test.tsx for the equivalent covering that template.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Playground } from '../Playground'
import type { Tool } from '../schema'

// A minimal fake WebSocket: jsdom has no real WS server to connect to, and
// the real backend protocol (hello/ack handshake, tool_call/tool_result)
// needs to be driven manually from the test to exercise handleToolMessage.
// Captures every outgoing send() call (JSON-parsed) so assertions can
// inspect exactly what Playground would have put on the wire.
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

  // Test-only helpers to drive the fake connection from outside.
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

function makeClickButtonTool(name = 'click_button', labelEnum?: string[]): Tool {
  return {
    name,
    description: 'Click a button on the page, identified by its visible label.',
    parameters: {
      type: 'object',
      properties: { label: { type: 'string', ...(labelEnum ? { enum: labelEnum } : {}) } },
      required: ['label'],
    },
    sourceTemplate: 'click_button',
  }
}

describe('Playground click_button mock', () => {
  let ws: FakeWebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    // jsdom doesn't implement Element.scrollTo — Playground calls it on the
    // transcript div whenever messages change (autoscroll), unrelated to
    // anything under test here.
    Element.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
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

  it('renders exactly the two default mock buttons, in order, when a click_button tool has no label enum', async () => {
    await renderConnected([makeClickButtonTool()])
    const buttons = ['Confirm', 'Cancel'].map((label) => screen.getByRole('button', { name: label }))
    expect(buttons).toHaveLength(2)
  })

  it('renders no mock buttons when no click_button-template tool exists', async () => {
    await renderConnected([])
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('renders one button per option in the tool label parameter enum, instead of the default set', async () => {
    await renderConnected([makeClickButtonTool('click_button', ['Approve', 'Reject', 'Skip'])])
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('a tool_call naming a known label flashes that button and reports genuine ok:true', async () => {
    await renderConnected([makeClickButtonTool()])

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'click_button', args: { label: 'Confirm' } },
      })
    })

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' })
    expect(confirmBtn.className).toContain('mockButtonClicked')

    const result = ws.lastSent('tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      requestId: 'r1',
      payload: {
        toolName: 'click_button',
        ok: true,
        result: { message: '"Confirm" clicked — button now shows the clicked state' },
      },
    })
  })

  it('the flash clears after CLICK_FLASH_MS (900ms)', async () => {
    await renderConnected([makeClickButtonTool()])
    await act(async () => {
      ws.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { toolName: 'click_button', args: { label: 'Cancel' } } })
    })
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('mockButtonClicked')

    await act(async () => {
      vi.advanceTimersByTime(900)
    })
    expect(screen.getByRole('button', { name: 'Cancel' }).className).not.toContain('mockButtonClicked')
  })

  it('only one button is flashed at a time (single global timer)', async () => {
    await renderConnected([makeClickButtonTool()])
    await act(async () => {
      ws.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { toolName: 'click_button', args: { label: 'Confirm' } } })
    })
    await act(async () => {
      ws.emitMessage({ type: 'tool_call', requestId: 'r2', payload: { toolName: 'click_button', args: { label: 'Cancel' } } })
    })
    expect(screen.getByRole('button', { name: 'Confirm' }).className).not.toContain('mockButtonClicked')
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('mockButtonClicked')
  })

  it('a tool_call naming an unknown label reports honest ok:false listing available labels, and flashes nothing', async () => {
    await renderConnected([makeClickButtonTool()])

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'click_button', args: { label: 'Checkout' } },
      })
    })

    for (const label of ['Confirm', 'Cancel']) {
      expect(screen.getByRole('button', { name: label }).className).not.toContain('mockButtonClicked')
    }

    const result = ws.lastSent('tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      requestId: 'r1',
      payload: {
        toolName: 'click_button',
        ok: false,
        error: 'no mock button labeled "Checkout" in Playground (available: Confirm, Cancel)',
      },
    })
  })

  it('a tool_call with no label at all reports ok:false with label rendered as null', async () => {
    await renderConnected([makeClickButtonTool()])

    await act(async () => {
      ws.emitMessage({
        type: 'tool_call',
        requestId: 'r1',
        payload: { toolName: 'click_button', args: {} },
      })
    })

    const result = ws.lastSent('tool_result')
    expect(result.payload).toEqual({
      toolName: 'click_button',
      ok: false,
      error: 'no mock button labeled null in Playground (available: Confirm, Cancel)',
    })
  })

  it('a human click flashes the button but sends no WebSocket message at all', async () => {
    await renderConnected([makeClickButtonTool()])
    const before = ws.sent.length

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(screen.getByRole('button', { name: 'Confirm' }).className).toContain('mockButtonClicked')
    expect(ws.sent.length).toBe(before)
  })

  it('a tool without a mock effect gets an honest ok:false after NO_MOCK_TIMEOUT_MS (2s), not a fabricated success', async () => {
    const plainTool: Tool = {
      name: 'do_something_else',
      description: 'Not a click_button tool.',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    await renderConnected([plainTool])

    await act(async () => {
      ws.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { toolName: 'do_something_else', args: {} } })
    })
    expect(ws.lastSent('tool_result')).toBeUndefined()

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    const result = ws.lastSent('tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      requestId: 'r1',
      payload: {
        toolName: 'do_something_else',
        ok: false,
        error: 'no mock effect for this tool in Playground; nothing here can perform it for real',
      },
    })
  })

  it('connection status shows Connected once open+ack land', async () => {
    await renderConnected([])
    expect(screen.getByText('Connected').textContent).toBe('Connected')
  })
})
