import React, { useEffect, useRef, useState } from 'react'
import { Button } from './ui'

/** Everything this page has kept in this browser goes: settings, grades, reads, the board, cached data. */
export const startOver = () => {
  try {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith('ff:')) window.localStorage.removeItem(k)
  } catch {
    // Storage blocked: nothing was kept to begin with.
  }
  window.location.reload()
}

/** Start over, asking once more in place before it clears; the safe choice takes focus. */
export const StartOver = () => {
  const [confirm, setConfirm] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirm) cancel.current?.focus({ preventScroll: true })
  }, [confirm])
  if (!confirm)
    return (
      <Button className="text-ff-neg hover:text-ff-neg" onClick={() => setConfirm(true)}>
        Start over…
      </Button>
    )
  return (
    <span role="group" aria-label="Start over" className="flex flex-wrap gap-1.5">
      <button type="button" onClick={startOver} className="h-8 border border-ff-neg/50 bg-ff-neg/10 px-3 text-[12.5px] font-medium text-ff-neg hover:bg-ff-neg/15 max-md:h-10">
        Clear and restart
      </button>
      <button ref={cancel} type="button" onClick={() => setConfirm(false)} className="h-8 border border-ff-line bg-ff-panel px-3 text-[12.5px] text-ff-text2 hover:bg-ff-raised max-md:h-10">
        Cancel
      </button>
    </span>
  )
}
