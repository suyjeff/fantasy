import React, { useEffect, useId } from 'react'
import { Button, PageHeader, Panel, usePhone } from '../ui'
import { AddIcon } from '../icons'
import { AsgmName } from './AsgmButtons'
import { AsgmChat } from './AsgmChat'
import { useAsgm, useAsgmControl } from './AsgmProvider'
import AsgmSettings, { providerLine } from './AsgmSettings'

/**
 * Assistant GM's own page: the same conversation as the window and the dock, given the screen. On wide screens the
 * settings and what the GM can do sit in a column beside it.
 */
const AsgmPage = () => {
  const s = useAsgm()
  const control = useAsgmControl()
  const titleId = useId()
  const phone = usePhone()
  // Arriving here is asking to talk: the composer takes focus (on a wide screen; a phone keeps its keyboard down).
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) control?.focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader
        title={<AsgmName live={!!s.running} />}
        mobileTitle
        meta={providerLine(s)}
        actions={
          s.messages.length > 0 && !phone ? (
            <Button size="sm" variant="ghost" onClick={s.clear}>
              <AddIcon size={11} />
              New conversation
            </Button>
          ) : undefined
        }
      />
      <h2 id={titleId} className="sr-only">
        Conversation with Assistant GM
      </h2>
      <div className="ff-page-body ff-grid-gap grid grid-cols-1 items-start xl:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-labelledby={titleId} className="asgm-page relative flex h-[calc(100dvh-var(--ff-top)-48px-env(safe-area-inset-bottom)-20px)] min-h-[380px] flex-col border border-ff-line bg-ff-panel md:h-[calc(100dvh-44px-var(--ff-gl)-12px)]">
          <span aria-hidden className="asgm-reg asgm-reg-tl" />
          <span aria-hidden className="asgm-reg asgm-reg-br" />
          <AsgmChat variant="page" titleId={titleId} />
        </section>
        {/* Not an ff-stack itself: that class sets display and would override `hidden` (styles/fantasy.css). */}
        <div className="hidden xl:block">
          <div className="ff-stack">
          <Panel title="Who answers">
            <AsgmSettings inline />
          </Panel>
          <Panel title="How it works">
            <ul className="space-y-2 text-[12.5px] leading-snug text-ff-text2">
              <li>
                <span className="ff-label mr-1.5 !text-ff-text2">Calls</span>The GM leads with the decision, then the numbers behind it.
              </li>
              <li>
                <span className="ff-label mr-1.5 !text-ff-text2">Numbers</span>Every figure comes from this app&apos;s own models, run in your browser on your league: lineups, trade pricing, accept odds, bids, playoff sims.
              </li>
              <li>
                <span className="ff-label mr-1.5 !text-ff-text2">Context</span>It knows the page you are on. Take the chip off to ask without it.
              </li>
              <li>
                <span className="ff-label mr-1.5 !text-ff-text2">History</span>New conversation keeps the last one. Past conversations holds your most recent conversations (up to 30) in this league, in this browser.
              </li>
              <li>
                <span className="ff-label mr-1.5 !text-ff-text2">Anywhere</span>Press <kbd className="border border-ff-line px-1 font-mono text-[10.5px]">G</kbd> on any page, or use the button at the top right.
              </li>
            </ul>
          </Panel>
          </div>
        </div>
      </div>
    </>
  )
}

export default AsgmPage
