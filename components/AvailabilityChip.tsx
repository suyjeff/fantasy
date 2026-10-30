import React from 'react'
import { clearsLabel, type Availability } from '../lib/availability'
import { Chip, cx } from './ui'

/**
 * Where a player stands in this league, as one chip: free to add, a waiver claim (with when he clears), yours, or
 * held by a named team. The word carries the meaning; the tone only backs it up.
 */
export const AvailabilityChip = ({ a, teamName, className, short }: { a: Availability; teamName?: (rosterId: number) => string | undefined; className?: string; short?: boolean }) => {
  if (a.kind === 'fa') return <Chip tone="pos" className={className}>Free agent</Chip>
  if (a.kind === 'waivers')
    return (
      <Chip tone="warn" className={className} title={`Dropped lately: a waiver claim until he clears (${new Date(a.clears).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })})`}>
        {short ? 'Waivers' : `On waivers · ${clearsLabel(a.clears)}`}
      </Chip>
    )
  if (a.kind === 'mine') return <Chip tone="accent" className={className}>Your team</Chip>
  const name = teamName?.(a.rosterId) ?? 'Rostered'
  return (
    <Chip className={cx('max-w-[160px]', className)} title={name}>
      {name}
    </Chip>
  )
}
