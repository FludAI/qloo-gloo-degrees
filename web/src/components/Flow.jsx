import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import Practice from "./Practice.jsx";
import SayIt from "./SayIt.jsx";
import PickCard, { artOf } from "./PickCard.jsx";
import { PawRow, SpokenPaw, useHeardToes } from "./Paw.jsx";
import { pawPlan } from "../lib/paw.js";
import { speak, hush } from "../lib/speak.js";
import { sfx } from "../lib/sfx.js";
import { CloseIcon } from "./Icons.jsx";
import { InviteButton } from "./Invite.jsx";

// After capture: one card at a time over the camera. Say it → one picture per sound piece → the whole
// word from their pictures → practice → progress. Pieces before meaning: the sounds stick first.
const HOW = { typed: "typed", voice: "heard", ocr: "read from a photo", camera: "read from the camera" };
const bareTitle = (term) => term.title.replace(/\s*\(.*?\)\s*/g, "").trim();

export default function Flow({ termId, glued, health, guard, credits, onCredits, say, degree = null, onClose, onRegue }) {
  const [term, setTerm] = useState(null);
  const [progress, setProgress] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const load = useCallback(() => api.term(termId).then(setTerm).catch((e) => setErr(e.message)), [termId]);
  const refresh = useCallback(() => api.progress(termId).then(setProgress).catch(() => {}), [termId]);
  useEffect(() => { setTerm(null); setStep(0); load(); refresh(); api.cues(termId).then(setChosen).catch(() => {}); return hush; }, [termId, load, refresh]);

  const pickRoles = useMemo(() => (term?.roles ?? []).filter((r) => r.pick?.options?.length), [term]);
  const steps = [...pickRoles.map((r) => `pick:${r.id}`), "together", "practice", "progress"];
  const current = steps[Math.min(step, steps.length - 1)];
  const next = () => setStep((s) => Math.min(s + 1, steps.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  useEffect(() => { if (current === "progress") refresh(); }, [current, refresh]); // the hooks line counts this lesson's picks

  const pickFor = (roleId) => chosen.find((c) => c.role === roleId);
  const onPicked = async (role, o) => {
    const prev = pickFor(role.id);
    if (prev) await api.removeCue(prev.id);
    // A card the agent proposed says so (via); the server looks the proposal up itself and keeps its verified ID.
    setChosen(await api.addCue({ term_id: term.id, recognized: true, role: role.id, label: o.name, connection: o.connection, source: "pick", qloo_entity_id: null, qloo_entity_type: o.qloo?.type ?? null, ...(o.via ? { via: o.via } : {}) }));
    onCredits?.(); // a first pick can complete a referred friend's first word
  };
  const close = () => { hush(); onClose(); };

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={term?.title ?? "Lesson"}>
        <div className="sheet-handle" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-[2rem] leading-none">{term?.title ?? "…"}</h2>
            {term?.pronunciation?.approx && term.pronunciation.approx !== "—" && <p className="mt-1 font-mono text-sm text-paper/60">{term.pronunciation.approx}</p>}
          </div>
          <button aria-label="Back to camera" className="round !h-10 !w-10" onClick={close}><CloseIcon /></button>
        </div>
        {glued && <Captured glued={glued} onRegue={onRegue} onClose={close} />}
        {term?.provisional && <p className="mt-3 rounded-xl bg-gloo/20 px-3 py-2 text-xs text-paper/80">Provisional draft by the agent, not reviewed.</p>}
        {err && <p className="mt-3 text-sm text-red-300">{err}</p>}

        {term?.locked && <FirstAttempt term={term} health={health} guard={guard} onSaved={() => { load(); refresh(); onCredits?.(); }} />}

        {term && !term.locked && (<>
          <Dots steps={steps} at={step} onPick={setStep} />
          {current.startsWith("pick:") && (() => {
            const role = pickRoles.find((r) => `pick:${r.id}` === current);
            return <PickCard key={role.id} term={term} role={role} mine={pickFor(role.id)} health={health} guard={guard} degree={degree} onPicked={onPicked} onNext={next} onBack={back} />;
          })()}
          {current === "together" && <Together term={term} roles={pickRoles} chosen={chosen} onNext={next} onBack={back} />}
          {current === "practice" && (<>
            <Practice term={term} health={health} guard={guard} onAttempt={refresh} onDone={next} />
            <div className="mt-4 flex items-center justify-between"><button className="btn-ghost" onClick={back}>Back</button><button className="btn-ghost" onClick={next}>Done</button></div>
          </>)}
          {current === "progress" && (<>
            <Skills progress={progress} chosen={chosen} term={term} roles={pickRoles} />
            {credits && (
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-xs text-paper/60"><img src="/brand/gloo-token.svg" alt="" className="mr-1 inline h-4 w-4 align-[-3px]" />{credits.policy}</p>
                <InviteButton credits={credits} say={say} className="btn-ghost shrink-0" />
              </div>
            )}
            <div className="mt-5 flex gap-2">
              <button className="btn-light flex-1" onClick={close}>Gloo another word</button>
              <button className="btn-ghost" onClick={() => setStep(steps.indexOf("practice"))}>Practice more</button>
            </div>
          </>)}
        </>)}
      </div>
    </div>
  );
}

function Dots({ steps, at, onPick }) {
  return (
    <div className="mt-3 flex gap-1.5" aria-label="Steps">
      {steps.map((s, i) => <button key={s} aria-label={s} className={`h-1.5 flex-1 rounded-full ${i <= at ? "bg-gloo" : "bg-paper/20"}`} onClick={() => onPick(i)} />)}
    </div>
  );
}

function Captured({ glued, onRegue, onClose }) {
  const r = glued.resolution;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper/60">
      <span>{HOW[r.mode] ?? r.mode}{r.input.toLowerCase() !== r.word ? ` “${r.input}”` : ""}</span>
      {glued.alternatives?.length > 0 && <span>· not this? {glued.alternatives.slice(0, 3).map((a) => <button key={a} className="mx-0.5 underline" onClick={() => onRegue({ text: a, mode: "typed" })}>{a}</button>)}</span>}
      <button className="underline" onClick={onClose}>gloo again</button>
    </div>
  );
}

// Saved before anything about the term is shown. Say it, or admit you don't know it yet.
// The server scores the attempt against the sound pieces; the paw lights a toe per syllable heard while they
// hold the mic, then settles to gold for the pieces they got and dim for the rest before the lesson opens.
function FirstAttempt({ term, health, guard, onSaved }) {
  const [busy, setBusy] = useState(false);
  const plan = useMemo(() => pawPlan(term, term.pieces ?? []), [term.id]);
  const paw = useHeardToes(plan);
  useEffect(() => { speak(term.first_attempt?.question ?? "Try to say this word. Just do your best.", { term }); return hush; }, [term.id]);
  const save = (body) => guard(async () => {
    setBusy(true);
    try {
      const r = await api.firstAttempt(term.id, body);
      if (r?.pieces) { paw.settle(r.pieces); sfx(r.pieces.said_count ? "chime" : "tick"); await new Promise((done) => setTimeout(done, 1500)); }
      onSaved();
    } finally { setBusy(false); }
  });
  return (
    <section className="mt-5">
      <p className="text-xl leading-snug">{term.first_attempt?.question ?? "Try to say this word. Just do your best."}</p>
      <PawRow n={plan.count} states={paw.states} size={plan.count > 5 ? 84 : 110} className="mt-4" label={`${plan.count} syllables`} />
      <div className="mt-4"><SayIt big health={health} guard={guard} onText={(t) => save({ response: t })} onLevel={paw.onLevel} onListening={paw.onListening} label="Hold and say it" /></div>
      <button className="mt-6 w-full text-sm text-paper/60 underline" disabled={busy} onClick={() => save({ skipped: true })}>I don't know it yet</button>
    </section>
  );
}

// The whole word, rebuilt from the pieces they just bonded: their pictures slide into word order,
// each lights as it is spoken, then the word lights once as a unit and the meaning appears.
function Together({ term, roles, chosen, onNext, onBack }) {
  const [more, setMore] = useState(false);
  const [lit, setLit] = useState(-1);
  const [glow, setGlow] = useState(false);
  const parts = roles.map((r) => ({ role: r, pick: chosen.find((c) => c.role === r.id) }))
    .map((x) => ({ ...x, option: x.pick ? x.role.pick.options.find((o) => o.name === x.pick.label) ?? null : null }));
  useEffect(() => {
    const timers = [];
    const slideEnd = 200 + roles.length * 40 + 620;
    timers.push(setTimeout(() => sfx("tick"), slideEnd));
    roles.forEach((r, i) => {
      const at = slideEnd + 200 + i * 900;
      timers.push(setTimeout(() => { setLit(i); sfx("tick"); speak(r.part, { term }); }, at));
    });
    const tL = slideEnd + 200 + roles.length * 900 + 200;
    timers.push(setTimeout(() => { setGlow(true); sfx("chime"); speak(`${bareTitle(term)}. ${term.summary}`, { term }); }, tL));
    return () => { timers.forEach(clearTimeout); hush(); };
  }, [term.id]);
  return (
    <section className="mt-3">
      <h3 className={`mb-2 text-center font-display text-[2rem] leading-none ${glow ? "word-glow" : ""}`} style={{ opacity: glow ? 1 : 0.35, transition: "opacity .3s" }}>{term.title.replace(/\s*\(.*?\)\s*/g, "")}</h3>
      <div className="stage">
        <div className={`grid h-full gap-2 ${parts.length > 2 ? "grid-cols-2" : "grid-cols-1"}`}>
          {parts.map(({ role, pick, option }, i) => (
            <div key={role.id} className="slide-in relative overflow-hidden rounded-2xl border border-paper/20 bg-paper/10" style={{ animationDelay: `${200 + i * 40}ms` }}>
              {artOf(option) ? <img src={artOf(option)} alt={pick.label} className="h-full w-full object-cover opacity-80" /> : null}
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/35 text-center">
                <div className={`font-display text-3xl leading-none ${lit >= i ? "light-up" : "text-paper"}`}>{role.part}</div>
                <div className="mt-1 text-sm font-medium">{role.meaning}</div>
                {pick && <div className="mt-1 text-[11px] text-paper/70">{pick.label}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <SpokenPaw term={term} size={56} className="mt-2" />
      <p className={`mt-2 text-center text-base leading-snug ${glow ? "fade-in" : "opacity-0"}`}>{term.summary}</p>
      <button className="mt-2 w-full text-center text-sm text-paper/60 underline" onClick={() => setMore(!more)}>{more ? "Less" : "More"}</button>
      {more && (
        <div className="mt-3 space-y-2 text-sm text-paper/80">
          <p>{term.definition}</p>
          {term.origin && <p className="text-paper/60">{term.origin}</p>}
          {term.formula && <div className="rounded-2xl bg-paper/10 px-4 py-3 font-mono"><div>{term.formula}</div><div className="mt-1 text-[11px] text-paper/60">{term.rules?.join(" · ")}</div></div>}
          {term.examples && <ul className="space-y-1">{term.examples.map((e) => <li key={e.story} className="flex justify-between gap-3"><span>{e.story}</span><span className="font-mono shrink-0">{e.loss}</span></li>)}</ul>}
          {term.distinctions?.length > 0 && <ul className="list-disc space-y-1 pl-5">{term.distinctions.map((d) => <li key={d}>{d}</li>)}</ul>}
          {term.family && <ul className="space-y-1">{term.family.map(([w, why]) => <li key={w}><span className="font-medium text-paper">{w}</span> <span className="text-paper/60">— {why}</span></li>)}</ul>}
          {term.transfer && <ul className="space-y-1">{term.transfer.map(([d, x]) => <li key={d}><span className="font-medium text-paper">{d}.</span> <span className="text-paper/60">{x}</span></li>)}</ul>}
          {term.sources?.length > 0 && <p className="text-xs text-paper/50">{term.sources.map((s, i) => <span key={s.url}>{i > 0 && " · "}<a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.label}</a></span>)}</p>}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between"><button className="btn-ghost" onClick={onBack}>Back</button><button className="btn-light" onClick={onNext}>Next</button></div>
    </section>
  );
}

// Progress: one bar per skill with a tick per review stage; the picks owned sit under the bars.
const STAGES = ["now", "30m", "4h", "1d", "3d", "7d"];
function Skills({ progress, chosen, term, roles }) {
  const roleLabel = Object.fromEntries((term?.roles ?? []).map((r) => [r.id, r.part ?? r.label]));
  const picks = chosen.map((c) => ({ c, option: roles.find((r) => r.id === c.role)?.pick.options.find((o) => o.name === c.label) }));
  const rows = progress ? Object.entries(progress.skills).filter(([k]) => k !== "pronunciation") : [];
  useEffect(() => { if (rows.some(([, s]) => s.stage > 0)) sfx("chime", 600); }, [progress]);
  return (
    <section className="mt-4">
      <div className="flex items-center gap-4 font-mono text-[10px] text-paper/60"><span className="w-20" />{STAGES.map((s) => <span key={s} className="flex-1 text-center">{s}</span>)}</div>
      {rows.map(([skill, s], r) => (
        <div key={skill} className="mt-2 flex items-center gap-4 slide-in" style={{ animationDelay: `${80 + r * 70}ms` }}>
          <span className="w-20 font-mono text-[11px] uppercase tracking-wider text-paper/80">{skill}</span>
          {STAGES.map((_, j) => (
            <span key={j} className="relative h-9 flex-1 rounded-lg border-2" style={{ borderColor: j < s.stage ? "var(--gloo)" : "rgba(246,241,231,.45)" }}>
              {j < s.stage && <span className="fill-up absolute inset-0.5 rounded-md bg-gloo" style={{ animationDelay: `${300 + r * 70 + j * 60}ms` }} />}
            </span>
          ))}
        </div>
      ))}
      <div className="mt-2 flex items-center gap-4"><span className="w-20 font-mono text-[11px] uppercase tracking-wider text-paper/40">sound</span><span className="font-mono text-[11px] text-paper/50">not assessed yet</span></div>
      {picks.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {picks.map(({ c, option }) => (
            <span key={c.id} className="chip !py-1 !pl-1">
              {artOf(option) ? <img src={artOf(option)} alt="" className="h-7 w-7 rounded-full object-cover" /> : <span className="h-7 w-7 rounded-full bg-paper/20" />}
              <span className="font-mono text-gloo">{roleLabel[c.role] ?? c.role}</span><span className="font-medium">{c.label}</span>
            </span>
          ))}
        </div>
      )}
      {progress?.hooks?.line && <p className="mt-3 text-xs text-paper/60">{progress.hooks.line}</p>}
      <p className="mt-3 text-xs text-paper/50">Review stages: now, 30 min, 4 h, 1 day, 3 days, 7 days. Hinted answers don't count as on your own.</p>
    </section>
  );
}
