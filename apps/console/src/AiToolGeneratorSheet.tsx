import { useEffect, useRef, useState } from 'react'
import type { Tool } from './schema'
import { generateToolFromDescription } from './aiToolGenerator'
import { focusAndReveal } from './focusField'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import styles from './ToolFieldSheet.module.css'

// Opened by MobileWorkspaceCards.tsx's "Generate with AI" button — collects a
// plain-language description, then hands off to aiToolGenerator.ts (the
// real WebSocket round trip against the tool-builder app). On success,
// onGenerated hands the proposed Tool to the caller's own isNew
// ToolEditSheet instance for review/edit before Save — this sheet's job
// ends the moment generation succeeds, not at Save.
export function AiToolGeneratorSheet({
  open,
  onClose,
  onGenerated,
}: {
  open: boolean
  onClose: () => void
  onGenerated: (tool: Tool) => void
}) {
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Resets to a blank draft every time this sheet opens — same "start
  // fresh" pattern every other field sheet here uses (ToolNameSheet etc.),
  // so a previous failed/cancelled attempt's text and error don't linger
  // into the next one.
  useEffect(() => {
    if (open) {
      setDescription('')
      setError(null)
      setGenerating(false)
      focusAndReveal(textareaRef.current)
    }
  }, [open])

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = description.trim()
    if (!trimmed || generating) return
    setGenerating(true)
    setError(null)
    try {
      const tool = await generateToolFromDescription(trimmed)
      onGenerated(tool)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate a tool.')
      setGenerating(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <form className={styles.form} onSubmit={handleGenerate}>
        <div className={styles.header}>
          <SheetHeader
            title="Generate with AI"
            onClose={onClose}
            saveType="submit"
            saveLabel={generating ? 'Generating…' : 'Generate'}
            saveDisabled={!description.trim() || generating}
          />
        </div>
        <div className={styles.body}>
          <p className={styles.intro}>
            Describe the tool you want in a sentence — AI will draft a complete definition (name,
            description, parameters) you can review or edit before saving.
          </p>
          <textarea
            ref={textareaRef}
            className={styles.descriptionInput}
            placeholder="e.g. Make a tool that fills in the search box with given text and submits it"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={generating}
          />
          {error && <p className={styles.nameError}>{error}</p>}
        </div>
      </form>
    </BottomSheet>
  )
}
