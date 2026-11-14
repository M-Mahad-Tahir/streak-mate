import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Rocket } from 'lucide-react';

/**
 * Win celebration: a rocket launches, flies to the streak, explodes like a
 * firework bomb and reveals "Your Win: N" (the student's current streak).
 */
export interface CelebrationOptions {
  streak: number;
  kind: 'completed' | 'verified';
  title?: string;
}

const Ctx = createContext<(o: CelebrationOptions) => void>(() => undefined);
export const useCelebrate = () => useContext(Ctx);

const FLIGHT_MS = 950;   // rocket flight time
const SHOW_MS = 4200;    // total time before auto-close

export function CelebrationProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<(CelebrationOptions & { id: number }) | null>(null);
  const celebrate = useCallback((o: CelebrationOptions) => setCurrent({ ...o, id: Date.now() }), []);
  return (
    <Ctx.Provider value={celebrate}>
      {children}
      {current && <CelebrationOverlay key={current.id} {...current} onClose={() => setCurrent(null)} />}
    </Ctx.Provider>
  );
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function CelebrationOverlay({ streak, kind, title, onClose }: CelebrationOptions & { onClose: () => void }) {
  const reduced = prefersReducedMotion();
  const [phase, setPhase] = useState<'launch' | 'boom'>(reduced ? 'boom' : 'launch');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const t1 = reduced ? 0 : window.setTimeout(() => setPhase('boom'), FLIGHT_MS);
    const t2 = window.setTimeout(onClose, SHOW_MS + (reduced ? -1500 : 0));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { if (t1) window.clearTimeout(t1); window.clearTimeout(t2); document.removeEventListener('keydown', onKey); };
  }, [onClose, reduced]);

  useEffect(() => { if (phase === 'boom') closeRef.current?.focus(); }, [phase]);

  // Explosion particles (canvas) when the rocket hits.
  useEffect(() => {
    if (phase !== 'boom' || reduced) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const cx = w / 2, cy = h * 0.42;
    const colors = ['#f97316', '#fb923c', '#facc15', '#ef4444', '#3538cd', '#14b8a6', '#ffffff'];
    const parts = Array.from({ length: 170 }, () => {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 9;
      return { x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2 + Math.random() * 4, life: 1, c: colors[(Math.random() * colors.length) | 0] };
    });
    let raf = 0;
    let ring = 0;
    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      // shockwave
      ring += 18;
      if (ring < Math.max(w, h)) {
        ctx.beginPath();
        ctx.arc(cx, cy, ring, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(251,146,60,${Math.max(0, 0.55 - ring / 900)})`;
        ctx.lineWidth = 10;
        ctx.stroke();
      }
      let alive = 0;
      for (const p of parts) {
        if (p.life <= 0) continue;
        alive++;
        p.x += p.vx; p.y += p.vy; p.vy += 0.14; p.vx *= 0.985; p.life -= 0.012;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (alive) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, reduced]);

  return (
    <div className={`ws-celebrate ${phase === 'boom' && !reduced ? 'ws-shake' : ''}`} role="dialog" aria-modal="true" aria-label={`Your Win: ${streak}`} onClick={onClose}>
      <style>{CSS}</style>
      <canvas ref={canvasRef} className="ws-canvas" aria-hidden />
      {phase === 'launch' && (
        <div className="ws-rocket" aria-hidden>
          <Rocket className="h-16 w-16" strokeWidth={1.8} />
          <span className="ws-trail" />
        </div>
      )}
      {phase === 'boom' && (
        <>
          {!reduced && <div className="ws-flash" aria-hidden />}
          <div className="ws-card" onClick={(e) => e.stopPropagation()}>
            <p className="ws-kicker">{kind === 'verified' ? 'Verified by your teacher!' : 'Work done!'}</p>
            {title && <p className="ws-task">{title}</p>}
            <p className="ws-your">YOUR WIN</p>
            <p className="ws-num">{streak}</p>
            <p className="ws-days">day streak {streak > 0 ? '🚀' : ''}</p>
            <button ref={closeRef} onClick={onClose} className="ws-btn">Keep going</button>
          </div>
        </>
      )}
    </div>
  );
}

const CSS = `
.ws-celebrate { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; overflow: hidden;
  background: radial-gradient(circle at 50% 42%, rgba(23,26,94,.86), rgba(15,23,42,.92)); cursor: pointer;
  animation: ws-fade .2s ease-out; }
.ws-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.ws-rocket { position: absolute; left: 50%; top: 42%; color: #fff; transform: translate(-50%, -50%) rotate(-45deg);
  animation: ws-fly ${FLIGHT_MS}ms cubic-bezier(.5,0,.75,.2) forwards; filter: drop-shadow(0 0 18px rgba(251,146,60,.9)); }
.ws-rocket svg { color: #fb923c; fill: rgba(255,255,255,.15); }
.ws-trail { position: absolute; left: -18px; top: 52px; width: 26px; height: 80px; border-radius: 50%;
  background: linear-gradient(to bottom, #facc15, #f97316 45%, transparent); transform: rotate(45deg); transform-origin: top; filter: blur(3px);
  animation: ws-flicker .08s infinite alternate; }
.ws-flash { position: absolute; left: 50%; top: 42%; width: 40px; height: 40px; border-radius: 50%; background: #fff;
  transform: translate(-50%, -50%); animation: ws-flash .5s ease-out forwards; pointer-events: none; }
.ws-card { position: relative; text-align: center; color: #fff; padding: 28px 40px; cursor: default;
  animation: ws-pop .6s cubic-bezier(.2,1.6,.4,1) both; }
.ws-kicker { font-weight: 700; color: #fdba74; letter-spacing: .02em; }
.ws-task { margin-top: 4px; font-size: .95rem; color: #bfe1fd; max-width: min(22rem, 80vw); margin-inline: auto; overflow-wrap: anywhere; }
.ws-your { margin-top: 14px; font-weight: 800; letter-spacing: .35em; font-size: clamp(1.1rem, 3vw, 1.5rem); color: #fff; }
.ws-num { font-weight: 900; line-height: .9; font-size: clamp(6rem, 22vw, 11rem);
  background: linear-gradient(180deg, #fde68a, #f97316 60%, #ef4444); -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 6px 30px rgba(249,115,22,.55)); font-variant-numeric: tabular-nums; }
.ws-days { font-weight: 700; color: #dbeefe; font-size: 1.1rem; }
.ws-btn { margin-top: 22px; padding: 10px 22px; border-radius: 999px; background: #fff; color: #1d4ed8; font-weight: 700; }
.ws-btn:focus-visible { outline: 3px solid #fb923c; outline-offset: 3px; }
.ws-shake { animation: ws-shake .45s ease-out; }
@keyframes ws-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes ws-fly { 0% { transform: translate(-50%, 60vh) rotate(-45deg) scale(.7); }
  70% { transform: translate(-48%, 4vh) rotate(-45deg) scale(1); } 100% { transform: translate(-50%, -50%) rotate(-45deg) scale(1.15); } }
@keyframes ws-flicker { from { opacity: .7; height: 70px } to { opacity: 1; height: 92px } }
@keyframes ws-flash { from { opacity: .95; width: 40px; height: 40px } to { opacity: 0; width: 140vmax; height: 140vmax } }
@keyframes ws-pop { 0% { transform: scale(.2); opacity: 0 } 100% { transform: scale(1); opacity: 1 } }
@keyframes ws-shake { 0%,100% { transform: none } 20% { transform: translate(-8px, 4px) } 40% { transform: translate(7px, -5px) }
  60% { transform: translate(-5px, 3px) } 80% { transform: translate(3px, -2px) } }
@media (prefers-reduced-motion: reduce) { .ws-celebrate, .ws-card { animation: none } }
`;
