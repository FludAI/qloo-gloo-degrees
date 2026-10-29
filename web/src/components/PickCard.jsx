import { useEffect, useRef, useState } from "react";
import SayIt from "./SayIt.jsx";
import { speak, hush } from "../lib/speak.js";
import { sfx } from "../lib/sfx.js";
import { flashRing } from "./Motion.jsx";
import { SpokenPaw } from "./Paw.jsx";

// One sound piece, one square of four pictures, one spoken line. The learner says their favorite
// (any answer counts, listed or not). Lock-in: the pick flashes a ring and snaps to its slot; then
// the piece rises out of it, its sound pulses with the spoken line, and the meaning fades in last.
const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const ratio = (a, b) => { const n = Math.max(a.length, b.length); if (!n) return 0; let d = 0; const m = Math.min(a.length, b.length); for (let i = 0; i < m; i++) if (a[i] !== b[i]) d++; return 1 - (d + n - m) / n; };

export function matchOption(transcript, options) {
  const t = squash(transcript);
  if (!t) return null;
  let best = null, score = 0;
  for (const o of options) {
    for (const alias of [o.name, ...(o.say ?? [])]) {
      const a = squash(alias);
      if (!a) continue;
      const s = t.includes(a) || a.includes(t) ? 1 : ratio(t, a);
      if (s > score) { score = s; best = o; }
    }
  }
  return score >= 0.72 ? best : null;
}

export default function PickCard({ term, role, mine, health, guard, onPicked, onNext, onBack }) {
  const [reveal, setReveal] = useState(mine ? { label: mine.label, option: role.pick.options.find((o) => o.name === mine.label) ?? null, custom: !role.pick.options.some((o) => o.name === mine.label), fresh: false } : null);
  const [picking, setPicking] = useState(null); // name of the tile locking in
  const spoken = useRef("");
  const tiles = useRef({});

  useEffect(() => {
    if (reveal) return;
    if (spoken.current !== role.id) { spoken.current = role.id; speak(role.pick.question, { term }); }
    return hush;
  }, [role.id, reveal]);

  const choose = (label, option) => guard(async () => {
    const connection = option?.connection ?? (role.sound_like ? `${label} ≈ ${role.part} (your pick; approximate sound of “${role.sound_like}”).` : `${label}: your pick for ${role.part} = ${role.meaning}.`);
    hush();
    setPicking(label);
    if (option) flashRing(tiles.current[option.name]);
    sfx("lock");
    await onPicked(role, { name: label, connection, qloo: option?.qloo ?? null });
    await new Promise((r) => setTimeout(r, option ? 640 : 200)); // others fall back, then the reveal
    setPicking(null);
    setReveal({ label, option, custom: !option, fresh: true });
    // When the piece is already spoken as its hook (chole is said "cola"), "like cola" would repeat it.
    const hooked = role.sound_like && ((role.say && role.say.toLowerCase() === String(role.sound_like).toLowerCase()) || squash(label) === squash(role.sound_like));
    const first = role.sound_like && !hooked ? `${label}. ${role.part}, like ${role.sound_like}.` : `${label}. ${role.part}.`;
    setTimeout(() => speak(first, { term }), 700);
    setTimeout(() => speak(`${role.part} means ${role.meaning}.`, { term }), 2400);
  });

  const onSaid = (transcript) => { const o = matchOption(transcript, role.pick.options); choose(o ? o.name : transcript.trim().replace(/^(my favorite( one)? is|it's|its|i like|i love)\s+/i, "").slice(0, 40), o); };

  if (reveal) {
    const a = reveal.fresh; // animate only on a fresh pick, not when revisiting
    return (
      <section className="mt-3">
        <div className="stage">
          <div className="grid h-full grid-cols-2 gap-3">
            <div className={a ? "rise" : ""}><Picture src={artOf(reveal.option)} fallback={wikiArt(reveal.option)} name={reveal.label} big custom={reveal.custom} whole={Boolean(reveal.option?.link)} /></div>
            <div className="flex flex-col items-center justify-center text-center">
              <div className={`font-display text-[2.6rem] leading-none text-gloo ${a ? "rise" : ""}`} style={a ? { animationDelay: ".7s" } : undefined}>{role.part}</div>
              <SpokenPaw term={term} piece={role} size={40} className={`mt-1 ${a ? "fade-in" : ""}`} />
              {role.sound_like && <div className={`mt-2 font-mono text-sm text-paper/70 ${a ? "fade-in pulse-word" : ""}`} style={a ? { animationDelay: "1.2s, 1.5s" } : undefined}>≈ {role.sound_like}</div>}
              <div className={`mt-4 text-xl font-medium ${a ? "fade-in" : ""}`} style={a ? { animationDelay: "2.4s" } : undefined}>{role.meaning}</div>
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-paper/50">{reveal.label}{reveal.custom ? " · your own pick" : ""}
          {reveal.option?.link && <> · <a className="underline underline-offset-2" href={reveal.option.link} target="_blank" rel="sponsored nofollow noopener">shop</a> <span className="font-mono text-[10px]">ad</span></>}</p>
        <div className="mt-3 flex items-center justify-between">
          <button className="btn-ghost" onClick={() => { hush(); setReveal(null); }}>Change</button>
          <button className="btn-light" onClick={onNext}>Next</button>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-3">
      <div className="stage">
        <div className="grid h-full grid-cols-2 gap-3">
          {role.pick.options.slice(0, 4).map((o) => (
            <button key={o.name} ref={(n) => { tiles.current[o.name] = n; }} className={`tile-img ${picking && picking !== o.name ? "fall-back" : ""} ${o.taste != null ? "ring-1 ring-gloo/60" : ""}`} disabled={!!picking} onClick={() => choose(o.name, o)} aria-label={o.name} data-taste={o.taste ?? undefined}>
              <Picture src={artOf(o)} fallback={wikiArt(o)} name={o.name} whole={Boolean(o.link)} />
              <span className="tile-cap">{o.name}{o.link && <span className="ml-1 font-mono text-[9px] opacity-70">ad</span>}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-center text-base">{role.pick.question}</p>
      <div className="mt-3 flex items-center justify-between">
        <button className="btn-ghost" onClick={onBack}>Back</button>
        <SayIt health={health} guard={guard} onText={onSaid} />
        <button className="btn-ghost" onClick={onNext}>Skip</button>
      </div>
    </section>
  );
}

// A tile's picture: the option's own (a Qloo record's, or an affiliate packshot), else the Wikipedia lead image.
// When the first fails to load, the second is tried before the name alone.
export const wikiArt = (o) => (o?.wiki ? `/api/art?t=${encodeURIComponent(o.wiki)}` : null);
export const artOf = (o) => o?.image ?? wikiArt(o);
function Picture({ src, fallback = null, name, big = false, custom = false, whole = false }) {
  const [failed, setFailed] = useState(0);
  if (custom) {
    // An off-list favorite: a waveform tile for what they said.
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl border border-paper/40 bg-paper/5 px-2">
        <div className="flex h-10 items-center gap-1">{[.3, .9, .5, 1, .4, .8, .35, .95, .5, .7, .3].map((h, i) => <span key={i} className="w-1 rounded bg-paper" style={{ height: `${h * 100}%` }} />)}</div>
        <span className="font-mono text-xs text-paper/80">“{name}”</span>
      </div>
    );
  }
  const use = failed === 0 ? src : failed === 1 && fallback && fallback !== src ? fallback : null;
  if (!use) {
    return <div className={`flex h-full w-full items-center justify-center rounded-2xl bg-paper/10 px-2 text-center ${big ? "font-display text-3xl" : "text-base font-medium"}`}>{name}</div>;
  }
  // A product shot (an affiliate picture on white) is shown whole on a white tile, so its label is never cropped
  // and two packshots line up; wiki and Qloo art fill the tile.
  return <img key={use} src={use} alt={name} className={`h-full w-full rounded-2xl ${whole ? "bg-white object-contain p-1" : "object-cover"}`} loading="lazy" onError={() => setFailed((n) => n + 1)} />;
}
