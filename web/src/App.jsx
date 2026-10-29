import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import Camera from "./components/Camera.jsx";
import Flow from "./components/Flow.jsx";
import Passcode from "./components/Passcode.jsx";
import AmbientGate from "./components/AmbientGate.jsx";
import Logo from "./components/Logo.jsx";
import WordsSheet from "./components/Words.jsx";
import { useHoldToTalk } from "./lib/talk.js";
import { sfx, warmAudio } from "./lib/sfx.js";
import { configureSpeech, lastSpoken, speechMode, unlockAudio } from "./lib/speak.js";
import { CameraIcon, CloseIcon, InfoIcon, MicIcon, PictureIcon, WordsIcon } from "./components/Icons.jsx";
import { Balance, InviteButton } from "./components/Invite.jsx";
import { imageFrom, inAppBrowser, isIOS, isPhone, micFix } from "./lib/device.js";

// Gloo is a camera. Camera and mic on (phone or glasses), or a shared window on a desktop, or a picture of
// the word; you don't proceed without one of them. No typing anywhere.
// Frame a word and tap, or hold the mic and say it. The scan sweeps the frame, drops a tick per
// piece it finds, then the lesson rises as cards over the viewfinder.
export default function App() {
  const cam = useRef(null);
  const [health, setHealth] = useState(null);
  const [terms, setTerms] = useState([]);
  const [camState, setCamState] = useState("idle");
  const [micGranted, setMicGranted] = useState(false);
  const [micBlocked, setMicBlocked] = useState(null); // set when the first hold is refused
  const [source, setSource] = useState(null); // camera | screen | image
  const [access, setAccess] = useState({}); // { slow, error, reason }: what the last permission request reported
  const picker = useRef(null);
  const [busy, setBusy] = useState("");
  const [scan, setScan] = useState(null);
  const [toast, setToast] = useState("");
  const [sheet, setSheet] = useState(null); // { termId, glued }
  const [info, setInfo] = useState(false);
  const [wordsOpen, setWordsOpen] = useState(false);
  const [pass, setPass] = useState(null); // { retry }
  const [credits, setCredits] = useState(null); // Gloo balance and referral link
  const [degree, setDegree] = useState(null); // this session's degree of Qloo (0..3), read once
  const [empty, setEmpty] = useState(""); // the server's line when a new word would cost more Gloo than there is
  const toastTimer = useRef(null);

  const say = useCallback((msg) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 3500); }, []);
  const loadHealth = useCallback(() => api.health().then((h) => { configureSpeech(h); setHealth(h); }).catch(() => setHealth({ offline: true })), []);
  const loadTerms = useCallback(() => api.terms().then(setTerms).catch(() => {}), []);
  const loadCredits = useCallback(() => api.credits().then(setCredits).catch(() => {}), []);
  useEffect(() => {
    // A shared link can carry the passcode (?code=...), so nobody has to type it, a friend's referral (?ref=...),
    // or a word (?word=cholecystokinin): its lesson opens over the gate, no camera needed for a word Gloo knows.
    const params = new URLSearchParams(location.search);
    const code = params.get("code"), ref = params.get("ref"), word = params.get("word"), qloo = params.get("qloo");
    const boot = Promise.resolve()
      .then(() => (code ? api.unlock(code).catch(() => {}) : null))
      .then(() => (ref ? api.claimReferral(ref).catch(() => {}) : null))
      .then(() => { if (code || ref || word || qloo != null) history.replaceState(null, "", location.pathname); });
    boot.then(() => {
      loadHealth(); loadTerms(); loadCredits();
      api.level().then((l) => setDegree(l.level)).catch(() => {});
      if (word) { const id = word.toLowerCase().trim(); api.term(id).then(() => setSheet({ termId: id, glued: null })).catch(() => say(`Gloo doesn't know “${word}” yet. Point the camera at it.`)); }
    });
  }, [loadHealth, loadTerms, loadCredits]);

  // Every metered action goes through here: a passcode challenge replays the action once unlocked.
  const guard = useCallback(async (fn) => {
    try { await fn(); }
    catch (e) {
      if (e?.code === "PASSCODE_REQUIRED") setPass({ retry: fn });
      else if (e?.code === "GLOO_EMPTY") { setEmpty(e.message); loadCredits(); }
      else say(e?.message ?? "Something went wrong.");
    }
  }, [say, loadCredits]);

  // Scan: the sweep runs while the server reads; when the word is known, one tick per piece drops
  // under the frame, the frame locks, and the lesson opens.
  const onGlued = async (result) => {
    await loadTerms();
    if (result.credits) loadCredits();
    let pieces = 0;
    try { pieces = (await api.term(result.term_id)).pieces?.length ?? 0; } catch { /* lesson still opens */ }
    if (pieces) { setScan({ pieces }); sfx("lock", 120 + pieces * 150 + 260); await new Promise((r) => setTimeout(r, 120 + pieces * 150 + 520)); }
    setScan(null);
    setSheet({ termId: result.term_id, glued: result });
  };
  const glue = (body, label) => guard(async () => {
    setBusy(label); if (body.mode === "camera" || body.image) setScan("sweep");
    try { await onGlued(await api.glue(body)); } catch (e) { setScan(null); throw e; } finally { setBusy(""); }
  });
  const frame = () => cam.current?.capture() ?? null;
  const glueFrame = () => {
    const f = frame();
    if (!f) return say(source === "camera" ? "Point the camera at a word first." : "Move the word into the frame first.");
    glue({ mode: "camera", ...f }, "Reading…");
  };
  // The microphone's own outcome, at the first hold anywhere on the page: shown on the live view and sent to the report.
  const onMic = useCallback((state) => {
    setMicGranted(state === "granted"); setMicBlocked(state === "blocked" ? "NotAllowedError" : null);
    api.beacon({ event: "mic", state, error: state === "blocked" ? "NotAllowedError" : null, platform: isIOS() ? "ios" : isPhone() ? "android" : "desktop" });
  }, []);
  const talk = useHoldToTalk({
    stt: health?.stt, onMic,
    onPcm: ({ pcm16 }) => glue({ mode: "voice", pcm16, ...(frame() ?? {}) }, "Listening…"),
    onText: ({ transcript }) => glue({ mode: "voice", text: transcript, ...(frame() ?? {}) }, "Listening…"),
  });

  const openCamera = (which = "camera") => { warmAudio(); unlockAudio(); cam.current?.start(which); };
  const showPicture = (file) => { if (!file) return; warmAudio(); unlockAudio(); cam.current?.show(file); };
  const onCamState = (s, extra) => {
    setCamState(s); setSource(extra?.source ?? null); setAccess({ slow: Boolean(extra?.slow), error: extra?.error ?? null, reason: extra?.reason ?? null });
    // What the gate saw, for the testers report: no names, no addresses, just the outcome and the kind of browser.
    if (s === "live" || s === "denied" || s === "unavailable" || extra?.slow) api.beacon({ event: "gate", state: s, source: extra?.source ?? null, error: extra?.error ?? null, reason: extra?.reason ?? null, slow: Boolean(extra?.slow), in_app: inAppBrowser(), platform: isIOS() ? "ios" : isPhone() ? "android" : "desktop" });
  };
  // A screenshot pasted or an image dropped anywhere on the page is the word.
  useEffect(() => {
    const onPaste = (e) => { const f = imageFrom(e.clipboardData); if (f) { e.preventDefault(); showPicture(f); } };
    const onDrop = (e) => { e.preventDefault(); const f = imageFrom(e.dataTransfer); if (f) showPicture(f); };
    const onDrag = (e) => { if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault(); };
    window.addEventListener("paste", onPaste); window.addEventListener("drop", onDrop); window.addEventListener("dragover", onDrag);
    return () => { window.removeEventListener("paste", onPaste); window.removeEventListener("drop", onDrop); window.removeEventListener("dragover", onDrag); };
  }, []);
  const pickFile = (e) => { const f = e.target.files?.[0]; e.target.value = ""; showPicture(f); };
  const live = camState === "live";

  return (
    <div className="relative h-full w-full select-none overflow-hidden bg-black text-paper">
      <Camera ref={cam} onState={onCamState} scan={scan}>
        <div className="safe-top absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4">
          <Logo />
          <div className="flex items-center gap-2">
            <Balance credits={credits} />
            <button className="round !h-9 !w-9" aria-label="Words" onClick={() => setWordsOpen(true)}><WordsIcon /></button>
            <button className="round !h-9 !w-9" aria-label="About this demo" onClick={() => setInfo(true)}><InfoIcon /></button>
          </div>
        </div>

        {!live && <AmbientGate state={camState} source={source} access={access} paused={Boolean(sheet) || wordsOpen || info} onStart={openCamera} onPick={showPicture} onOpen={(id) => { warmAudio(); unlockAudio(); setSheet({ termId: id, glued: null }); }} />}

        {live && (<>
          <p className="pointer-events-none absolute inset-x-0 z-10 text-center text-sm text-paper/80" style={{ top: "calc(50% - 22vh/2 - clamp(84px,16vh,150px)/2 - 2.2rem)" }}>
            {busy || (talk.listening ? "Listening… release when done" : source === "camera" ? "Frame the word and tap, or hold the mic and say it." : "Drag the word into the frame, then tap or hold the mic and say it.")}
          </p>
          {micBlocked && !busy && !sheet && (
            <p className="pointer-events-none absolute inset-x-0 z-10 px-8 text-center text-[13px] leading-snug text-gloo" style={{ top: "calc(50% - 22vh/2 - clamp(84px,16vh,150px)/2 - 0.6rem)" }}>
              {micFix()} <span className="font-mono text-[11px] text-paper/50">{micBlocked}</span>
            </p>
          )}
          {terms.length > 0 && !sheet && (
            <div className="absolute inset-x-0 z-10 flex gap-2 overflow-x-auto px-4 pb-1" style={{ bottom: "calc(8.5rem + env(safe-area-inset-bottom))", scrollbarWidth: "none" }}>
              {terms.map((t) => (
                <button key={t.id} className="shrink-0 rounded-full bg-black/50 px-3 py-1.5 text-sm text-paper backdrop-blur" onClick={() => setSheet({ termId: t.id, glued: null })}>
                  {t.title}{t.provisional && <span className="ml-1 font-mono text-[10px] opacity-70">draft</span>}
                </button>
              ))}
            </div>
          )}
          <div className="safe-bottom absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-8 px-6">
            <button className="round" aria-label={isPhone() ? "Take a picture of the word" : "Use a picture of the word"} disabled={!!busy} onClick={() => picker.current?.click()}><PictureIcon /></button>
            <input ref={picker} type="file" accept="image/*" capture={isPhone() ? "environment" : undefined} className="hidden" onChange={pickFile} />
            <button className="shutter" aria-label="Gloo it: read the framed word" disabled={!!busy || talk.listening} onClick={glueFrame}>
              <span className="font-display text-xl">Gloo it</span>
            </button>
            {talk.mode !== "none" ? (
              <button className={`round ${talk.listening ? "round-live listening" : ""}`} aria-label="Hold to say the word" aria-pressed={talk.listening} disabled={!!busy} {...talk.holdProps}><MicIcon /></button>
            ) : <span className="h-14 w-14" />}
          </div>
        </>)}

        {(toast || (talk.error && !busy)) && <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-6" style={{ bottom: "calc(12rem + env(safe-area-inset-bottom))" }}><span className="toast">{toast || talk.error}</span></div>}
        {empty && (
          <div className="absolute inset-x-0 z-20 flex justify-center px-6" style={{ bottom: "calc(12rem + env(safe-area-inset-bottom))" }}>
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl bg-black/75 px-5 py-4 text-center backdrop-blur" role="alert">
              <p className="text-base leading-snug">{empty}</p>
              <div className="flex items-center gap-2">
                <InviteButton credits={credits} say={say} className="btn-light !py-2" />
                <button className="btn-ghost" onClick={() => setEmpty("")}>Not now</button>
              </div>
            </div>
          </div>
        )}
      </Camera>

      {sheet && <Flow termId={sheet.termId} glued={sheet.glued} health={health} guard={guard} credits={credits} onCredits={loadCredits} say={say} degree={degree}
        onClose={() => { setSheet(null); loadTerms(); }} onRegue={(body) => glue(body, "Gluing…")} />}
      {wordsOpen && <WordsSheet onPick={(id) => { setWordsOpen(false); warmAudio(); unlockAudio(); setSheet({ termId: id, glued: null }); }} onClose={() => setWordsOpen(false)} />}
      {info && <InfoSheet health={health} micGranted={micGranted} degree={degree} onClose={() => setInfo(false)} />}
      {pass && <Passcode onClose={() => setPass(null)} onUnlocked={async () => { const retry = pass.retry; setPass(null); await loadHealth(); if (retry) guard(retry); }} />}
    </div>
  );
}

// Owner's debug area: did the last clip sound right? Right pins it forever; wrong unpins it. Not part of the learner flow.
function VerifyClip() {
  const last = lastSpoken();
  const [state, setState] = useState("");
  if (!last) return <p className="mt-4 font-mono text-[11px] text-paper/40">debug · voice {speechMode()} · nothing played yet</p>;
  const mark = (verified) => api.sayVerify({ ...last, verified }).then((r) => setState(r.verified ? "pinned" : "unpinned")).catch((e) => setState(e.message));
  return (
    <div className="mt-4 rounded-xl border border-paper/15 px-3 py-2 font-mono text-[11px] text-paper/60">
      <div>debug · voice {speechMode()} · last: “{last.text.slice(0, 60)}{last.text.length > 60 ? "…" : ""}”</div>
      <div className="mt-1.5 flex items-center gap-2">
        <button className="rounded-full border border-paper/30 px-2 py-0.5" onClick={() => mark(true)}>sounds right</button>
        <button className="rounded-full border border-paper/30 px-2 py-0.5" onClick={() => mark(false)}>sounds wrong</button>
        {state && <span>{state}</span>}
      </div>
    </div>
  );
}

function InfoSheet({ health, micGranted, degree, onClose }) {
  const [msg, setMsg] = useState("");
  const download = async () => {
    const blob = new Blob([JSON.stringify(await api.exportData(), null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "gloo-my-data.json" });
    a.click(); URL.revokeObjectURL(a.href);
  };
  const wipe = async () => { await api.deleteData(); setMsg("Deleted. Reloading…"); setTimeout(() => location.reload(), 800); };
  const row = (label, ok, note) => <li className="flex items-center justify-between"><span>{label}</span><span className={`rounded-full px-2 py-0.5 text-[11px] ${ok ? "bg-sea text-paper" : "bg-gloo/30 text-paper"}`}>{note}</span></li>;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet max-h-[75vh]" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="flex items-center justify-between"><h2 className="font-display text-3xl">Gloo × Qloo</h2><button aria-label="Close" className="round !h-10 !w-10" onClick={onClose}><CloseIcon /></button></div>
        <p className="mt-2 text-sm text-paper/80">Gloo pulls the sound pieces out of a hard word and hooks each one to something you already like. Your picks are the hooks. Practice hides them.</p>
        {health && !health.offline && (
          <ul className="mt-4 space-y-1.5 text-sm">
            {row("Camera reading", health.camera === "live", health.camera)}
            {row("Speech", health.stt === "google", health.stt === "google" ? "server" : health.stt === "mock" ? "mock" : "browser only")}
            {row("Voice", health.tts === "google", health.tts === "google" ? health.voice ?? "server" : "browser only")}
            {row("Microphone", micGranted, micGranted ? "allowed" : "asked at the first hold")}
            {row("Cue agent", health.agent.mode === "live", health.agent.mode === "live" ? health.agent.model : health.agent.mode)}
            {row("Qloo", health.qloo.ready, health.qloo.mode === "mock" ? "mock data" : health.qloo.ready ? "live" : "key missing")}
          </ul>
        )}
        {health?.tts === "google" && health?.unlocked && <VerifyClip />}
        <p className="mt-4 text-xs text-paper/50">Only the framed crop and a few seconds of audio go to the server; nothing is stored. Motion studies: <a className="underline" href="/motion/studies.html">/motion/studies.html</a>.{degree != null && <span className="ml-2 font-mono text-[10px] text-paper/40">degree {degree}</span>}</p>
        <p className="mt-3 flex gap-3 text-xs text-paper/60">
          <button className="underline" onClick={download}>Export my data</button>
          <button className="underline" onClick={wipe}>Delete my data</button>
          {msg && <span>{msg}</span>}
        </p>
      </div>
    </div>
  );
}
