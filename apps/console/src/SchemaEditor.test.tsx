import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SchemaEditor } from './SchemaEditor'

describe('SchemaEditor lockedPropertyNames', () => {
  it('prevents renaming a locked property via the name input', () => {
    const onChange = vi.fn()
    render(
      <SchemaEditor
        schema={{ type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }}
        onChange={onChange}
        hideRootHeader
        lockedPropertyNames={['label']}
      />,
    )
    const input = screen.getByDisplayValue('label') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    fireEvent.change(input, { target: { value: 'buttonLabel' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('prevents removing a locked property via the remove button', () => {
    const onChange = vi.fn()
    const { container } = render(
      <SchemaEditor
        schema={{ type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }}
        onChange={onChange}
        hideRootHeader
        lockedPropertyNames={['label']}
      />,
    )
    const button = container.querySelector('button[aria-label="Remove property"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('prevents toggling required on a locked property', () => {
    const onChange = vi.fn()
    const { container } = render(
      <SchemaEditor
        schema={{ type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }}
        onChange={onChange}
        hideRootHeader
        lockedPropertyNames={['label']}
      />,
    )
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves an unlocked property fully editable', () => {
    const onChange = vi.fn()
    render(
      <SchemaEditor
        schema={{ type: 'object', properties: { value: { type: 'string' } }, required: [] }}
        onChange={onChange}
        hideRootHeader
        lockedPropertyNames={['label']}
      />,
    )
    const input = screen.getByDisplayValue('value') as HTMLInputElement
    expect(input.readOnly).toBe(false)
    fireEvent.change(input, { target: { value: 'renamed' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('still allows editing type, description, and enum on a locked property', () => {
    const onChange = vi.fn()
    render(
      <SchemaEditor
        schema={{ type: 'object', properties: { label: { type: 'string', enum: ['Confirm', 'Cancel'] } }, required: ['label'] }}
        onChange={onChange}
        hideRootHeader
        lockedPropertyNames={['label']}
      />,
    )
    const enumInput = screen.getByDisplayValue('Confirm, Cancel') as HTMLInputElement
    fireEvent.change(enumInput, { target: { value: 'Approve, Reject, Skip' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
