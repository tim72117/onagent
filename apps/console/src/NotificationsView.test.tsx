// Covers the notification → action-target wiring: a notification that names
// a target reaches the handler with that target attached, and one that only
// carries a label does not pretend to have somewhere to go.
//
// Same conventions as CardMenuSheet.test.tsx: no @testing-library/jest-dom,
// explicit cleanup().
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NotificationsView } from './NotificationsView'
import type { Notification } from './api'

const FIXTURE_NOTIFICATIONS: Notification[] = [
  {
    id: 1,
    appId: 'my-app',
    title: 'Thanks for signing up',
    body: 'Tell us what you are building.',
    actionLabel: 'Join Builder →',
    actionTarget: 'useCaseForm',
    status: 'pending',
    createdAt: '2026-09-14T09:00:00Z',
    readAt: null,
    completedAt: null,
  },
  {
    id: 2,
    appId: 'my-app',
    title: 'Your first tool is ready',
    body: 'Nice work creating your first tool.',
    actionLabel: 'Open Playground →',
    status: 'pending',
    createdAt: '2026-09-13T10:00:00Z',
    readAt: null,
    completedAt: null,
  },
  {
    id: 3,
    appId: 'my-app',
    title: 'Feedback received',
    body: 'Thanks for sharing feedback — we read every note.',
    status: 'completed',
    createdAt: '2026-09-12T15:30:00Z',
    readAt: '2026-09-12T16:00:00Z',
    completedAt: '2026-09-12T16:00:00Z',
  },
]

afterEach(cleanup)

function renderView(onOpenAction = vi.fn()) {
  render(
    <NotificationsView
      notifications={FIXTURE_NOTIFICATIONS}
      onDismiss={() => {}}
      onOpenAction={onOpenAction}
    />,
  )
  return onOpenAction
}

describe('NotificationsView', () => {
  it('passes the action target through so App can route on it', () => {
    const onOpenAction = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Join Builder →' }))

    expect(onOpenAction).toHaveBeenCalledTimes(1)
    const n = onOpenAction.mock.calls[0][0] as Notification
    expect(n.actionTarget).toBe('useCaseForm')
  })

  it('still renders actions that have no target yet', () => {
    // Most mock notifications suggest a step with nowhere to go — they must
    // keep their button rather than being filtered out for lacking a target.
    const onOpenAction = renderView()
    const btn = screen.getByRole('button', { name: 'Open Playground →' })
    fireEvent.click(btn)

    const n = onOpenAction.mock.calls[0][0] as Notification
    expect(n.actionTarget).toBeUndefined()
  })

  it('hides completed notifications from the list entirely', () => {
    // Completing the suggested action (App.tsx's completeUseCaseNotification)
    // means the row's job is done — it disappears the same way dismissing
    // it would, rather than lingering with a "done" label.
    renderView()
    expect(screen.queryByText('Feedback received')).toBeNull()
  })

  it('still shows pending notifications alongside a hidden completed one', () => {
    renderView()
    expect(screen.queryByText('Thanks for signing up')).not.toBeNull()
    expect(screen.queryByText('Your first tool is ready')).not.toBeNull()
  })
})
