import React, { useEffect, useRef } from 'react';

interface Props {
  parallaxIndex?: number;
}

interface Orb {
  x: number;
  y: number;
  r: number;
  sprite: number;
  alpha: number;
  driftVx: number;
  bobAmp: number;
  bobSpeed: number;
  phase: number;
  pf: number;
}

const ORB_COLORS = ['232,201,106', '154,122,224', '111,192,168'];

const makeSprite = (rgb: string): HTMLCanvasElement => {
  const size = 128;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext('2d');
  if (!ctx) return sprite;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb},0.75)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.5)`);
  grad.addColorStop(0.78, `rgba(${rgb},0.14)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return sprite;
};

/** 前景散景层（压在内容之上）：大颗柔光斑缓慢漂移 + 最强视差，制造镜头前虚化景深。 */
export const TarotBokeh: React.FC<Props> = ({ parallaxIndex = 0 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const parallaxRef = useRef(parallaxIndex);

  useEffect(() => { parallaxRef.current = parallaxIndex; }, [parallaxIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const sprites = ORB_COLORS.map(makeSprite);
    const margin = 160;
    let width = 0;
    let height = 0;
    let orbs: Orb[] = [];
    let elapsed = 0;
    let offsetPx = 0;
    let raf = 0;
    let lastDraw = 0;
    let running = false;

    const wrap = (v: number, span: number): number => ((v % span) + span) % span - margin;

    const makeOrbs = () => {
      const count = width >= 700 ? 12 : 9;
      orbs = Array.from({ length: count }, () => ({
        x: Math.random() * (width + margin * 2) - margin,
        y: height * (0.06 + Math.random() * 0.82),
        r: 40 + Math.random() * 90,
        sprite: Math.floor(Math.random() * sprites.length),
        alpha: 0.035 + Math.random() * 0.035,
        driftVx: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 6),
        bobAmp: 6 + Math.random() * 12,
        bobSpeed: 0.15 + Math.random() * 0.25,
        phase: Math.random() * Math.PI * 2,
        pf: 0.8 + Math.random() * 0.7,
      }));
    };

    const drawOrbs = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      const span = width + margin * 2;
      orbs.forEach((o) => {
        const x = wrap(o.x + time * o.driftVx + offsetPx * o.pf, span);
        const y = o.y + Math.sin(time * o.bobSpeed + o.phase) * o.bobAmp;
        ctx.globalAlpha = o.alpha;
        ctx.drawImage(sprites[o.sprite], x - o.r, y - o.r, o.r * 2, o.r * 2);
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      width = Math.max(1, rect?.width ?? window.innerWidth);
      height = Math.max(1, rect?.height ?? window.innerHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      makeOrbs();
      if (reduce) drawOrbs(0);
    };

    const frame = (now: number) => {
      if (!running) return;
      if (now - lastDraw < 16) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min((now - lastDraw) / 1000, 0.05);
      lastDraw = now;
      elapsed += dt;
      offsetPx += (-(parallaxRef.current - 1.5) * 34 - offsetPx) * Math.min(1, dt * 2);
      drawOrbs(elapsed);
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (reduce || running) return;
      running = true;
      lastDraw = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    document.addEventListener('visibilitychange', onVisibility);
    start();

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 z-30 h-full w-full" />;
};
