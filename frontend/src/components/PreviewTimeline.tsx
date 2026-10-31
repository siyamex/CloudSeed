import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { formatClock, type SpriteInfo } from '../api';

/**
 * A seek bar with picture previews: hover (or drag on a touch screen) to see roughly what is at that point, click to jump there.
 * It sits under the player and works alongside the browser's own controls, which cannot show previews.
 */
export function PreviewTimeline({ media, spriteUrl, sprite, fallbackDurationMs }: {
  media: RefObject<HTMLMediaElement | null>; spriteUrl: string; sprite: SpriteInfo; fallbackDurationMs: number | null;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState((fallbackDurationMs ?? 0) / 1000);
  const [hover, setHover] = useState<{ frac: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = media.current;
    if (!el) return;
    const sync = () => { setTime(el.currentTime); if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration); };
    sync();
    for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked']) el.addEventListener(ev, sync);
    return () => { for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked']) el.removeEventListener(ev, sync); };
  }, [media]);

  const fracAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const jump = (to: number) => { const el = media.current; if (el && duration > 0) { el.currentTime = Math.min(Math.max(0, to), duration); setTime(el.currentTime); } };

  const onDown = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); const f = fracAt(e.clientX); setHover({ frac: f }); jump(f * duration); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { const f = fracAt(e.clientX); setHover({ frac: f }); if (dragging) jump(f * duration); };
  const onUp = () => setDragging(false);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 30 : 5;
    const to = e.key === 'ArrowLeft' ? time - step : e.key === 'ArrowRight' ? time + step : e.key === 'Home' ? 0 : e.key === 'End' ? duration : null;
    if (to === null) return;
    e.preventDefault(); e.stopPropagation(); // the player's own shortcuts must not also act on this key
    jump(to);
  };

  const at = hover ? hover.frac * duration : 0;
  const idx = Math.min(sprite.frames - 1, Math.max(0, Math.floor(at / sprite.intervalSec)));
  const col = idx % sprite.cols, row = Math.floor(idx / sprite.cols);
  const width = bar.current?.clientWidth ?? 0;
  const left = hover ? Math.min(Math.max(0, hover.frac * width - sprite.tileWidth / 2), Math.max(0, width - sprite.tileWidth)) : 0;
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;

  return (
    <div className="pt-1">
      <div className="relative">
        {hover && duration > 0 && (
          <div aria-hidden className="pointer-events-none absolute bottom-full z-10 mb-2 overflow-hidden rounded-md border border-line bg-black shadow-lg" style={{ left, width: sprite.tileWidth }}>
            <div style={{
              width: sprite.tileWidth, height: sprite.tileHeight, backgroundImage: `url(${spriteUrl})`, backgroundRepeat: 'no-repeat',
              backgroundSize: `${sprite.cols * sprite.tileWidth}px ${sprite.rows * sprite.tileHeight}px`, backgroundPosition: `-${col * sprite.tileWidth}px -${row * sprite.tileHeight}px`,
            }} />
            <div className="bg-black/80 py-0.5 text-center text-xs text-white">{formatClock(at * 1000)}</div>
          </div>
        )}
        <div ref={bar} role="slider" tabIndex={0} aria-label="Timeline with previews" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatClock(time * 1000)} of ${formatClock(duration * 1000)}`} onKeyDown={onKey}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => { if (!dragging) setHover(null); }}
          className="group relative h-4 cursor-pointer touch-none select-none rounded outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent">
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line group-hover:h-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
