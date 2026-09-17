import { useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { Input } from './Input'

type ConfirmDialogProps = {
  open: boolean
  onClose: () => void
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
  destructive?: boolean
  confirmText?: string
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = false,
  confirmText,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')

  const canConfirm = confirmText ? typed === confirmText : true

  const handleConfirm = () => {
    if (canConfirm) {
      onConfirm()
      setTyped('')
    }
  }

  const handleClose = () => {
    setTyped('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-compact text-content-secondary">{description}</p>
      {confirmText && (
        <div className="mt-4">
          <p className="text-caption text-content-tertiary mb-2">
            Type <span className="font-mono font-semibold text-content-primary">{confirmText}</span> to confirm
          </p>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmText}
          />
        </div>
      )}
    </Modal>
  )
}
