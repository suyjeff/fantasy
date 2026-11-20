import React, { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { useFantasy } from '../FantasyContext'
import { useModal } from '../Sheet'
import SwipeSheet, { type SwipeSheetHandle } from '../SwipeSheet'
import { useTradeDock } from '../TradeDock'
import { useMedia, usePhone } from '../ui'
import { AsgmChat } from './AsgmChat'
import { useAsgm, useAsgmContext, useAsgmControl } from './AsgmProvider'
import { sectionContext } from './contexts'

// Where the conversation shows when it is not on its own page. Wide screens: a window floating in the bottom-right
// corner (above the trade dock's minimized cards when there are some), or, from 1440px, docked as a panel down the
// right side that the page moves over for (styles/fantasy.css, html[data-asgm-dock]); it is never laid over the page.
// Phones: a sheet from the bottom, nearly the screen's height, swiped down or tapped above to close, as the trade
// builder's is.

/** Give focus back where it came from when the GM goes, unless the reader has since put it somewhere on purpose. */
const useGiveBack = (panel: React.RefObject<HTMLElement | null>) => {
  const s = useAsgm()
  const opener = s.opener
  useEffect(
    () => () => {
      const at = document.activeElement
      if (at && at !== document.body && !panel.current?.contains(at)) return
      // The control that opened it, or else the GM's own button (whichever one is on screen).
      const back = opener.current?.isConnected && opener.current.offsetParent !== null ? opener.current : [...document.querySelectorAll<HTMLElement>('[data-asgm-trigger]')].find((x) => x.offsetParent !== null)
      back?.focus({ preventScroll: true })
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
}

/** Escape closes, from anywhere inside, unless something inside (a menu) takes it first. */
const useEscape = (panel: React.RefObject<HTMLElement | null>, close: () => void) => {
  const fn = useRef(close)
  fn.current = close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (!t || !panel.current?.contains(t) || t.closest('[role="combobox"][aria-expanded="true"], [aria-expanded="true"][aria-haspopup]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-asgm])')) return
      e.preventDefault()
      fn.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])
}

const Float = ({ close, onDock, onExpand }: { close: () => void; onDock?: () => void; onExpand: () => void }) => {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const dock = useTradeDock()
  // Above the dock's minimized trade cards, which sit in this same corner.
  const lifted = dock && dock.mode !== 'open' && (dock.count > 0 || dock.toast)
  const roomy = useMedia('(min-width: 1024px)')
  useGiveBack(panel)
  useEscape(panel, close)
  return (
    <div
      ref={panel}
      data-asgm=""
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="asgm-float fixed right-4 z-[33] flex w-[360px] max-w-[calc(100vw-32px)] flex-col lg:w-[400px] border border-ff-line2 bg-ff-panel shadow-[0_18px_60px_-12px_rgba(0,0,0,0.45),0_2px_8px_rgba(0,0,0,0.12)]"
      // Never up into the page's 44px title row, where the GM's own button lives.
      // Under 1024px (a tablet, a narrow window) it is narrower and at most about two thirds of the height, so the
      // page it is talking about stays in view above and beside it; a full sheet there would hide the page entirely.
      style={{ bottom: lifted ? 88 : 16, height: `min(${roomy ? '660px' : '68dvh'}, calc(100dvh - ${(lifted ? 88 : 16) + 56}px))` }}
    >
      <span aria-hidden className="asgm-reg asgm-reg-tl" />
      <span aria-hidden className="asgm-reg asgm-reg-br" />
      <AsgmChat variant="float" titleId={titleId} onClose={close} onDock={onDock} onExpand={onExpand} />
    </div>
  )
}

const Dock = ({ close, onDock, onExpand }: { close: () => void; onDock: () => void; onExpand: () => void }) => {
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  useGiveBack(panel)
  useEscape(panel, close)
  // The page makes room: everything in it moves over by the panel's width, laid out once (not every frame).
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.asgmDock = ''
    return () => {
      delete root.dataset.asgmDock
    }
  }, [])
  return (
    <aside ref={panel} data-asgm="" aria-labelledby={titleId} className="asgm-dock fixed bottom-0 right-0 top-0 z-[32] flex flex-col border-l border-ff-line bg-ff-panel pr-[env(safe-area-inset-right)]">
      <AsgmChat variant="dock" titleId={titleId} onClose={close} onDock={onDock} onExpand={onExpand} />
    </aside>
  )
}

const PhoneSheet = ({ close, onExpand }: { close: () => void; onExpand: () => void }) => {
  const swipe = useRef<SwipeSheetHandle>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const leave = () => (swipe.current ? swipe.current.dismiss() : close())
  useModal(panel, leave)
  return (
    <SwipeSheet
      ref={swipe}
      side="bottom"
      className="z-[44]"
      onDismissed={close}
      backdropClassName="bg-black/45"
      panelRef={panel}
      panelProps={{ role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1, ...({ 'data-asgm': '' } as object) }}
      panelClassName="flex h-[calc(100dvh-40px)] w-full flex-col border-t border-ff-line2 bg-ff-panel shadow-[0_-8px_40px_rgba(0,0,0,0.35)] outline-none"
    >
      <div className="flex h-3 shrink-0 items-end justify-center" aria-hidden>
        <span className="h-1 w-10 bg-ff-line2" />
      </div>
      <AsgmChat variant="sheet" titleId={titleId} onClose={leave} onExpand={onExpand} onGoto={leave} />
    </SwipeSheet>
  )
}

/** Shows the conversation in the window, the dock or the phone's sheet, whichever fits. Rendered once, above the page. */
export const AsgmHost = () => {
  const s = useAsgm()
  const control = useAsgmControl()
  const phone = usePhone()
  // Docking takes 400px from the page, and the pages' own layouts go by the window's width, not their own: from
  // 1440px the page keeps at least 820px beside the sidebar, enough for every layout it switches to there.
  const wide = useMedia('(min-width: 1440px)')
  if (!control || !s.ready || s.onPage || !s.open) return null
  const close = control.close
  const expand = () => {
    control.close()
    s.goPage()
  }
  if (phone) return <PhoneSheet close={close} onExpand={expand} />
  const toggleDock = () => s.setDocked(!s.docked)
  return s.docked && wide ? <Dock close={close} onDock={toggleDock} onExpand={expand} /> : <Float close={close} onDock={wide ? toggleDock : undefined} onExpand={expand} />
}

/** Publishes the page the reader is on as the GM's context. Rendered once, inside the league's providers. */
export const AsgmRoute = ({ section, sub }: { section: string; sub: string | null }) => {
  const { data, analysis } = useFantasy()
  useAsgmContext(sectionContext(section, sub, analysis, data.projectionWeek ?? data.horizon[0]?.week ?? null))
  return null
}
