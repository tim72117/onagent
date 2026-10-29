import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge, imageFromBlob } from './client'

// Images attached to prompts: the payload shape the backend expects
// (protocol.PromptPayload.Images) and the File/Blob → base64 helper.

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readyState = 0
  sent: string[] = []
  private listeners: Record<string, ((ev: any) => void)[]> = {}

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (ev: any) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  openAndAck(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
    this.emit('message', {
      data: JSON.stringify({ type: 'ack', payload: { sessionId: 's', toolNames: [] } }),
    })
  }

  private emit(type: string, ev: any): void {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
}

let bridge: AgentBridge | undefined

function connectedBridge(): { bridge: AgentBridge; ws: FakeWebSocket } {
  bridge = new AgentBridge({ url: 'wss://example.test/ws', appId: 'test-app', tools: {} })
  const ws = FakeWebSocket.instances[0]
  ws.openAndAck()
  return { bridge, ws }
}

function sentPrompts(ws: FakeWebSocket): any[] {
  return ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'prompt')
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  bridge?.close()
  bridge = undefined
  vi.unstubAllGlobals()
})

describe('prompt with images', () => {
  it('sends the images alongside the text, in order', () => {
    const { bridge, ws } = connectedBridge()
    const images = [
      { mediaType: 'image/png', data: 'AAAA' },
      { mediaType: 'image/jpeg', data: 'BBBB' },
    ]

    bridge.prompt('compare these', { images })

    const [prompt] = sentPrompts(ws)
    expect(prompt.payload).toEqual({ text: 'compare these', images })
  })

  it('leaves images out of a text-only prompt', () => {
    const { bridge, ws } = connectedBridge()

    bridge.prompt('hello')
    bridge.prompt('again', { images: [] })

    for (const prompt of sentPrompts(ws)) {
      expect(prompt.payload).not.toHaveProperty('images')
    }
  })
})

describe('imageFromBlob', () => {
  it('encodes the bytes as base64 with the blob type', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const image = await imageFromBlob(new Blob([bytes], { type: 'image/png' }))

    expect(image).toEqual({ mediaType: 'image/png', data: 'iVBORwD/' })
  })

  it('handles an image larger than one encoding chunk', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    const image = await imageFromBlob(new Blob([bytes], { type: 'image/webp' }))

    const decoded = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))
    expect(decoded).toEqual(bytes)
  })

  it('rejects a type the backend will not accept', async () => {
    await expect(imageFromBlob(new Blob(['<svg/>'], { type: 'image/svg+xml' }))).rejects.toThrow(/unsupported image type/)
  })
})
