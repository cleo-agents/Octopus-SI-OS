import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { useShouldReduceMotion } from "../../appearance";
import { homeSurfaceFade } from "../../client-surfaces/homeSurfaceMotion";
import { OcButton, OcIconButton, OcSelect } from "../../design-system/components";
import type { VoiceSession } from "./useVoiceSession";
import { formatCallDuration, voicePresentation } from "./voicePresentation";

type CallPanel = "transcript" | "devices" | null;

export function HomeCallControls({ session, onStart, speakerEnabled, onSpeakerChange }: {
  session: VoiceSession;
  onStart: () => void;
  speakerEnabled: boolean;
  onSpeakerChange: (enabled: boolean) => void;
}) {
  const [panel, setPanel] = useState<CallPanel>(null);
  const [dismissedFailure, setDismissedFailure] = useState("");
  const [nowMs, setNowMs] = useState(() => performance.now());
  const devicesButton = useRef<HTMLButtonElement>(null);
  const transcriptButton = useRef<HTMLButtonElement>(null);
  const devicesPanel = useRef<HTMLDivElement>(null);
  const transcriptPanel = useRef<HTMLElement>(null);
  const devicesId = useId();
  const transcriptId = useId();
  const state = voicePresentation(session.phase);
  const muted = session.phase === "muted";
  const live = state.active || session.phase === "ending" || session.phase === "closure_unconfirmed";
  const failures = [...new Set([session.error, session.deviceError].filter(Boolean))];
  const failure = failures.join("\n\n");
  const showFailure = failures.length > 0 && failure !== dismissedFailure;
  const transcript = live ? session.transcript.filter((entry) => entry.text.trim()) : [];
  const latestUtterance = transcript.at(-1);
  const showCaptions = session.phase === "listening" || muted || session.phase === "recovering";
  const transcriptOpen = panel === "transcript" && transcript.length > 0;
  const devicesOpen = panel === "devices" && live;
  const ticking = live && session.startedAtMs > 0;

  useEffect(() => {
    setNowMs(performance.now());
    if (!state.active || session.startedAtMs <= 0) return;
    const timer = window.setInterval(() => setNowMs(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [session.startedAtMs, state.active]);

  useEffect(() => {
    if (!live || session.phase === "requesting") setPanel(null);
  }, [live, session.phase]);

  useEffect(() => {
    setPanel((current) => current === "transcript" ? null : current);
  }, [session.startedAtMs]);

  useEffect(() => {
    if (!failure) setDismissedFailure("");
  }, [failure]);

  useLayoutEffect(() => {
    const sheet = transcriptPanel.current;
    if (!transcriptOpen || !sheet) return;
    sheet.scrollTop = sheet.scrollHeight;
    sheet.focus({ preventScroll: true });
  }, [transcriptOpen]);

  useLayoutEffect(() => {
    if (devicesOpen) devicesPanel.current?.focus({ preventScroll: true });
  }, [devicesOpen]);

  return (
    <AnimatePresence>{live || showFailure ? <HomeCallTransition className={`home-call is-${session.phase}`} onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || (!devicesOpen && !transcriptOpen)) return;
      if (event.target instanceof Element && event.target.closest('[data-oc-dropdown], button[aria-haspopup="menu"][aria-expanded="true"]')) return;
      event.stopPropagation();
      event.preventDefault();
      (transcriptOpen ? transcriptButton : devicesButton).current?.focus({ preventScroll: true });
      setPanel(null);
    }}>{(present) => <>
      {live && showCaptions && latestUtterance && !transcriptOpen ? (
        <div key={latestUtterance.id} aria-live="polite" aria-atomic="true" className={`home-call__caption is-${latestUtterance.role}`} title={latestUtterance.text}>
          <p className="home-call__caption-text">
            <span className="home-call__caption-speaker">{latestUtterance.role === "user" ? "You: " : "Home: "}</span>
            {latestUtterance.text}
          </p>
        </div>
      ) : null}
      {transcriptOpen ? (
        <section aria-label="Call transcript" className="home-call__sheet home-call__transcript" id={transcriptId} ref={transcriptPanel} tabIndex={0}>
          {transcript.map((entry) => (
            <article className={`is-${entry.role}`} key={entry.id}>
              <strong>{entry.role === "user" ? "You" : "Home"}</strong>
              <p>{entry.text}</p>
            </article>
          ))}
        </section>
      ) : null}
      {devicesOpen ? (
        <div aria-label="Audio devices" className="home-call__sheet home-call__devices" id={devicesId} ref={devicesPanel} role="group" tabIndex={-1}>
          <div className="home-call__devices-heading">
            <span className="home-call__devices-title">Audio</span>
            {state.active ? <OcButton aria-pressed={!speakerEnabled} className="home-call__speaker" disabled={!state.canEnd} leadingIcon={speakerEnabled ? "volume" : "volumeOff"} onClick={() => onSpeakerChange(!speakerEnabled)} size="sm" variant="ghost">{speakerEnabled ? "Mute speaker" : "Unmute speaker"}</OcButton> : null}
          </div>
          <OcSelect aria-label="Microphone" disabled={!state.canMute && !state.canStart} label="Microphone" onChange={(id) => { void session.selectInputDevice(id); }} options={session.inputDevices.map((device) => ({ value: device.deviceId, label: device.label }))} showLabel stretch title={session.inputDevices.find((device) => device.deviceId === session.selectedInputId)?.label} value={session.selectedInputId} />
          <OcSelect aria-label="Speaker" disabled={!state.canMute && !state.canStart} label="Speaker" onChange={(id) => { void session.selectOutputDevice(id); }} options={session.outputDevices.map((device) => ({ value: device.deviceId, label: device.label }))} showLabel stretch title={session.outputDevices.find((device) => device.deviceId === session.selectedOutputId)?.label} value={session.selectedOutputId} />
          {session.inputDevices.length === 0 ? <p>No microphone is available. Check your device and microphone permissions.</p> : null}
        </div>
      ) : null}
      {live ? (
        <nav aria-label="Voice controls" className="home-call__bar is-layout-ready" data-voice-forming={present || undefined} data-voice-leaving={!present || undefined}>
          <div className="home-call__clock" title={state.detail}>
            <span aria-hidden="true" className="home-call__dot" />
            <span aria-label="Call duration" className="home-call__duration">{ticking ? formatCallDuration(nowMs - session.startedAtMs) : "–:––"}</span>
            <span className="home-call__status" role="status">{state.title}</span>
          </div>
          <span aria-hidden="true" className="home-call__divider" />
          {state.active ? (
            <OcIconButton
              aria-pressed={muted}
              className="home-call__control"
              disabled={!state.canMute}
              glyph={muted ? "microphoneOff" : "microphone"}
              label={muted ? "Unmute microphone" : "Mute microphone"}
              onClick={session.toggleMute}
              selected={muted}
              size="md"
              variant="ghost"
            />
          ) : null}
          {transcript.length > 0 ? (
            <OcIconButton
              aria-controls={transcriptOpen ? transcriptId : undefined}
              aria-expanded={transcriptOpen}
              buttonRef={transcriptButton}
              className="home-call__control"
              glyph="transcript"
              label={transcriptOpen ? "Hide call transcript" : "Show call transcript"}
              onClick={() => setPanel(transcriptOpen ? null : "transcript")}
              selected={transcriptOpen}
              size="md"
              variant="ghost"
            />
          ) : null}
          {session.phase === "closure_unconfirmed"
            ? <OcButton className="home-call__end" leadingIcon="phoneEnd" onClick={() => { void session.end(); }} size="sm" title={state.detail} variant="ghost">Retry closure</OcButton>
            : <OcButton aria-label="End call" className="home-call__end" disabled={!state.canEnd} leadingIcon="phoneEnd" onClick={() => { void session.end(); }} size="sm" variant="ghost">End</OcButton>}
          <span aria-hidden="true" className="home-call__divider" />
          <OcIconButton
            aria-controls={devicesOpen ? devicesId : undefined}
            aria-expanded={devicesOpen}
            buttonRef={devicesButton}
            className="home-call__control"
            glyph="sliders"
            label={devicesOpen ? "Collapse audio controls" : "More audio controls"}
            onClick={() => { setPanel(devicesOpen ? null : "devices"); if (!devicesOpen) void session.refreshDevices(); }}
            selected={devicesOpen}
            size="md"
            variant="ghost"
          />
        </nav>
      ) : null}
      {showFailure ? (
        <div className="home-call__failure">
          <div className="home-call__failure-row">
            <p className="home-call__error" role="alert">{session.error ? session.phase === "closure_unconfirmed" ? "Call closure is unconfirmed." : "Voice call failed." : "Check your audio devices."}</p>
            {session.phase === "error" ? <OcButton className="home-call__retry" leadingIcon="retry" onClick={() => { setPanel(null); onStart(); }} size="sm" variant="ghost">Retry call</OcButton> : null}
            {live ? null : <OcIconButton className="home-call__dismiss" glyph="close" label="Dismiss" onClick={() => { setDismissedFailure(failure); session.dismissError(); }} size="xs" variant="ghost" />}
          </div>
          <details className="home-call__diagnostics">
            <summary>Error details</summary>
            <pre>{failure}</pre>
          </details>
        </div>
      ) : null}
    </>}</HomeCallTransition> : null}</AnimatePresence>
  );
}

function HomeCallTransition({ children, className, onKeyDown }: {
  children: (present: boolean) => ReactNode;
  className: string;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
}) {
  const present = useIsPresent();
  const reducedMotion = useShouldReduceMotion();
  return <motion.section {...homeSurfaceFade(reducedMotion)} aria-label="Home call" className={className}
    data-leaving={!present || undefined} inert={!present || undefined} onKeyDown={onKeyDown}>
    {children(present)}
  </motion.section>;
}
