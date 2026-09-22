import React, { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  r: number;
  vy: number;
  swayAmp: number;
  swaySpeed: number;
  phase: number;
  twinkleSpeed: number;
  baseAlpha: number;
  gold: boolean;
  flare: boolean;
  layer: 0 | 1 | 2;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  fire: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
}

interface ConstellationDef {
  name: string;
  points: { x: number; y: number }[];
  lines: [number, number][];
}

interface DomeItem {
  def: ConstellationDef;
  theta: number;
  phi: number;
  size: number;
  rotation: number;
  phase: number;
  breathSpeed: number;
}

interface Props {
  parallaxIndex?: number;
}

const CONSTELLATIONS: ConstellationDef[] = [
  {
    name: '北斗七星',
    points: [
      { x: -0.36, y: -0.24 }, { x: -0.26, y: -0.12 }, { x: -0.14, y: -0.04 }, { x: -0.02, y: -0.1 },
      { x: 0.1, y: -0.04 }, { x: 0.22, y: 0.08 }, { x: 0.36, y: 0.24 },
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]],
  },
  {
    name: '仙后座',
    points: [
      { x: -0.4, y: 0.05 }, { x: -0.2, y: -0.18 }, { x: 0, y: 0.08 }, { x: 0.2, y: -0.18 }, { x: 0.4, y: 0.05 },
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    name: '猎户座',
    points: [
      { x: -0.22, y: -0.22 }, { x: 0.18, y: -0.22 }, { x: -0.1, y: 0 }, { x: 0, y: 0.02 },
      { x: 0.1, y: 0.04 }, { x: 0.24, y: 0.24 }, { x: -0.16, y: 0.24 },
    ],
    lines: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 6], [4, 5]],
  },
  {
    name: '天鹅座',
    points: [
      { x: 0, y: -0.38 }, { x: 0, y: 0.38 }, { x: -0.28, y: 0.06 }, { x: 0.28, y: 0.1 }, { x: 0, y: 0 },
    ],
    lines: [[0, 4], [4, 1], [2, 4], [4, 3]],
  },
  {
    name: '天秤座',
    points: [
      { x: -0.28, y: -0.06 }, { x: 0, y: 0.08 }, { x: 0.28, y: -0.06 }, { x: 0.02, y: 0.26 },
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0]],
  },
  {
    name: '金牛座',
    points: [
      { x: -0.3, y: -0.16 }, { x: 0, y: 0.06 }, { x: 0.3, y: -0.16 }, { x: 0.16, y: -0.4 }, { x: -0.16, y: -0.4 },
    ],
    lines: [[0, 1], [1, 2], [0, 3], [2, 4]],
  },
  {
    name: '狮子座',
    points: [
      { x: -0.34, y: -0.12 }, { x: -0.2, y: -0.3 }, { x: -0.02, y: -0.34 }, { x: 0.08, y: -0.18 },
      { x: 0.02, y: 0.02 }, { x: 0.3, y: 0.08 }, { x: 0.14, y: 0.28 },
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [4, 5], [5, 6], [6, 4]],
  },
  {
    name: '天鹰座',
    points: [
      { x: 0, y: -0.36 }, { x: 0, y: 0 }, { x: -0.3, y: 0.16 }, { x: 0.3, y: 0.16 }, { x: 0.18, y: 0.32 }, { x: -0.16, y: 0.32 },
    ],
    lines: [[0, 1], [1, 2], [1, 3], [3, 4], [2, 5]],
  },
];

const MAX_METEORS = 8;
const MAX_SPARKS = 120;
const PARALLAX_BASE = 34;

interface Sprites {
  glowGold: HTMLCanvasElement;
  glowWhite: HTMLCanvasElement;
  crossGold: HTMLCanvasElement;
  crossWhite: HTMLCanvasElement;
}

const makeSprites = (): Sprites => {
  const glow = (rgb: string) => {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (g) {
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, `rgba(${rgb},1)`);
      grad.addColorStop(0.35, `rgba(${rgb},0.55)`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    }
    return c;
  };
  const cross = (rgb: string) => {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (g) {
      g.translate(size / 2, size / 2);
      g.lineWidth = 1.4;
      for (let i = 0; i < 2; i++) {
        const grad = g.createLinearGradient(-size / 2, 0, size / 2, 0);
        grad.addColorStop(0, `rgba(${rgb},0)`);
        grad.addColorStop(0.5, `rgba(${rgb},0.95)`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        g.strokeStyle = grad;
        g.beginPath();
        g.moveTo(-size / 2 + 4, 0);
        g.lineTo(size / 2 - 4, 0);
        g.stroke();
        g.rotate(Math.PI / 2);
      }
    }
    return c;
  };
  return {
    glowGold: glow('232,201,106'),
    glowWhite: glow('255,248,226'),
    crossGold: cross('232,201,106'),
    crossWhite: cross('255,248,226'),
  };
};

/** 星空层：银河带 + 三层视差星 + 满屏星座连线 + 流星/火流星/流星雨；Tab 视差 + 60fps 封顶。 */
export const TarotParticles: React.FC<Props> = ({ parallaxIndex = 0 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const parallaxRef = useRef(parallaxIndex);

  useEffect(() => { parallaxRef.current = parallaxIndex; }, [parallaxIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const sprites = makeSprites();
    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let sparks: Spark[] = [];
    let milky: HTMLCanvasElement | null = null;
    let dome: DomeItem[] = [];
    let yawBase = -(parallaxIndex - 1.5) * 0.9;
    let showerTimer = 30 + Math.random() * 40;
    let showerQueue: { delay: number; x: number; y: number }[] = [];
    let nextMeteor = 1.2 + Math.random() * 2;
    let elapsed = 0;
    let offsetPx = 0;
    let raf = 0;
    let lastDraw = 0;
    let running = false;

    const wrap = (v: number, span: number): number => ((v % span) + span) % span;
    const isWide = () => width >= 700;

    const buildLayer = (
      count: number,
      layer: 0 | 1 | 2,
      cfg: { rMin: number; rMax: number; vMin: number; vMax: number; aMin: number; aMax: number; flare: number },
    ): Star[] =>
      Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: cfg.rMin + Math.random() * (cfg.rMax - cfg.rMin),
        vy: cfg.vMin + Math.random() * (cfg.vMax - cfg.vMin),
        swayAmp: 4 + Math.random() * 10,
        swaySpeed: 0.1 + Math.random() * 0.22,
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.4 + Math.random() * 1.1,
        baseAlpha: cfg.aMin + Math.random() * (cfg.aMax - cfg.aMin),
        gold: Math.random() < 0.7,
        flare: Math.random() < cfg.flare,
        layer,
      }));

    const makeStars = () => {
      const counts: [number, number, number] = isWide() ? [85, 75, 60] : [60, 55, 35];
      stars = [
        ...buildLayer(counts[0], 0, { rMin: 0.4, rMax: 0.8, vMin: 3, vMax: 6, aMin: 0.1, aMax: 0.25, flare: 0 }),
        ...buildLayer(counts[1], 1, { rMin: 0.7, rMax: 1.2, vMin: 6, vMax: 10, aMin: 0.22, aMax: 0.45, flare: 0.08 }),
        ...buildLayer(counts[2], 2, { rMin: 1.1, rMax: 1.9, vMin: 9, vMax: 15, aMin: 0.4, aMax: 0.8, flare: 0.4 }),
      ];
    };

    const makeMilkyWay = () => {
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(width * dpr));
      off.height = Math.max(1, Math.round(height * dpr));
      const mctx = off.getContext('2d');
      if (!mctx) return null;
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ax = width * 0.05;
      const ay = -height * 0.1;
      const dx = width * 1.0;
      const dy = height * 0.85;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const bandHalf = Math.min(width, height) * 0.26;
      const count = isWide() ? 560 : 420;
      for (let i = 0; i < count; i++) {
        const t = Math.random();
        const g = (Math.random() * 2 - 1 + (Math.random() * 2 - 1)) / 2;
        const x = ax + dx * t + nx * g * bandHalf;
        const y = ay + dy * t + ny * g * bandHalf;
        const r = 0.3 + Math.random() * 0.7;
        const alpha = (1 - Math.abs(g)) * (0.08 + Math.random() * 0.14);
        mctx.beginPath();
        mctx.arc(x, y, r, 0, Math.PI * 2);
        const roll = Math.random();
        mctx.fillStyle = roll < 0.25
          ? `rgba(232, 201, 106, ${alpha})`
          : roll < 0.55
            ? `rgba(190, 180, 235, ${alpha})`
            : `rgba(255, 255, 255, ${alpha})`;
        mctx.fill();
      }
      return off;
    };

    const THETA_MAX = 1.05;

    const setupDome = () => {
      const count = isWide() ? 24 : 18;
      const GA = Math.PI * (3 - Math.sqrt(5));
      dome = Array.from({ length: count }, (_, i) => ({
        def: CONSTELLATIONS[i % CONSTELLATIONS.length],
        theta: THETA_MAX * (0.2 + 0.8 * Math.sqrt((i + 0.5) / count)),
        phi: i * GA + (Math.random() - 0.5) * 0.4,
        size: 0.3 + Math.random() * 0.12,
        rotation: (Math.random() * 70 - 35) * (Math.PI / 180),
        phase: Math.random() * Math.PI * 2,
        breathSpeed: 0.08 + Math.random() * 0.12,
      }));
    };

    const spawnMeteor = (origin?: { x: number; y: number }) => {
      if (meteors.length >= MAX_METEORS) return;
      const fire = Math.random() < 0.25;
      const rightwards = true;
      const speed = fire ? 340 + Math.random() * 120 : 280 + Math.random() * 180;
      const angle = (26 + Math.random() * 24) * (Math.PI / 180);
      meteors.push({
        x: origin ? origin.x : rightwards ? width * (-0.05 + Math.random() * 0.7) : width * (0.35 + Math.random() * 0.7),
        y: origin ? origin.y : height * (-0.05 + Math.random() * 0.4),
        vx: Math.cos(angle) * speed * (rightwards ? 1 : -1),
        vy: Math.sin(angle) * speed,
        life: 0,
        ttl: fire ? 1.4 + Math.random() * 0.4 : 1.2 + Math.random() * 0.5,
        fire,
      });
    };

    const drawGlow = (sprite: HTMLCanvasElement, x: number, y: number, radius: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
      ctx.globalAlpha = 1;
    };

    const drawCross = (sprite: HTMLCanvasElement, x: number, y: number, len: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, x - len, y - len, len * 2, len * 2);
      ctx.globalAlpha = 1;
    };

    const drawDome = (yawRot: number) => {
      const cx = width / 2;
      const cy = height * 0.44;
      const unit = Math.min(width, height) * 0.5;
      const project = (theta: number, phi: number) => {
        const r = unit * (theta + 0.3 * theta * theta * theta);
        return { x: cx + Math.cos(phi) * r, y: cy + Math.sin(phi) * r };
      };
      dome.forEach((item) => {
        const alpha = 0.72 + 0.28 * Math.sin(elapsed * item.breathSpeed + item.phase);
        const phi = item.phi + yawRot;
        const anchor = project(item.theta, phi);
        const margin = item.size * unit * 0.9;
        if (anchor.x < -margin || anchor.x > width + margin || anchor.y < -margin || anchor.y > height + margin) return;
        const cosR = Math.cos(item.rotation);
        const sinR = Math.sin(item.rotation);
        const axp = Math.cos(phi) * item.theta;
        const ayp = Math.sin(phi) * item.theta;
        const pt = (p: { x: number; y: number }) => {
          const dx = (p.x * cosR - p.y * sinR) * item.size;
          const dy = (p.x * sinR + p.y * cosR) * item.size;
          const theta = Math.sqrt((axp + dx) * (axp + dx) + (ayp + dy) * (ayp + dy));
          const angle = Math.atan2(ayp + dy, axp + dx);
          return project(theta, angle);
        };
        item.def.lines.forEach(([i1, i2]) => {
          const p1 = item.def.points[i1];
          const p2 = item.def.points[i2];
          ctx.beginPath();
          for (let s = 0; s <= 10; s++) {
            const tt = s / 10;
            const sp = pt({ x: p1.x + (p2.x - p1.x) * tt, y: p1.y + (p2.y - p1.y) * tt });
            if (s === 0) ctx.moveTo(sp.x, sp.y);
            else ctx.lineTo(sp.x, sp.y);
          }
          ctx.strokeStyle = `rgba(160, 130, 220, ${0.12 * alpha})`;
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.strokeStyle = `rgba(232, 201, 106, ${0.42 * alpha})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        });
        item.def.points.forEach((p, pi) => {
          const sp = pt(p);
          const tw = 0.5 + 0.5 * Math.sin(elapsed * (0.6 + (pi % 5) * 0.25) + item.phase + pi * 1.7);
          const r = (pi === 0 ? 1.9 : 1.3) + tw * 0.7;
          drawGlow(sprites.glowWhite, sp.x, sp.y, r * 4, 0.22 * alpha);
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 248, 226, ${(0.45 + 0.5 * tw) * alpha})`;
          ctx.fill();
          if (pi === 0) drawCross(sprites.crossGold, sp.x, sp.y, r * 3.4, 0.5 * alpha * tw);
        });
        const dx = anchor.x - cx;
        const dy = anchor.y - cy;
        if (item.def.name !== '北斗七星' && Math.sqrt(dx * dx + dy * dy) < unit * 0.42) {
          ctx.font = '10px serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = `rgba(232, 201, 106, ${0.2 * alpha})`;
          ctx.fillText(item.def.name, anchor.x, anchor.y + item.size * 0.62);
        }
      });
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      if (milky) {
        ctx.globalAlpha = 0.9;
        ctx.drawImage(milky, 0, 0, width, height);
        ctx.globalAlpha = 1;
      }
      stars.forEach((s) => {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.gold
          ? `rgba(232, 201, 106, ${s.baseAlpha})`
          : `rgba(255, 255, 255, ${s.baseAlpha * 0.8})`;
        ctx.fill();
        if (s.flare) drawCross(s.gold ? sprites.crossGold : sprites.crossWhite, s.x, s.y, s.r * 3.2, s.baseAlpha * 0.8);
      });
      drawDome(yawBase);
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
      meteors = [];
      sparks = [];
      showerQueue = [];
      makeStars();
      milky = makeMilkyWay();
      setupDome();
      if (reduce) drawStatic();
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
      offsetPx += (-(parallaxRef.current - 1.5) * PARALLAX_BASE - offsetPx) * Math.min(1, dt * 2);
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      if (milky) {
        ctx.globalAlpha = 0.9;
        ctx.drawImage(milky, offsetPx * 0.2, 0, width, height);
        ctx.globalAlpha = 1;
      }

      const layerFactors = [0.2, 0.55, 1];
      stars.forEach((s) => {
        s.y -= s.vy * dt;
        if (s.y < -4) {
          s.y = height + 4;
          s.x = Math.random() * width;
        }
        const x = wrap(s.x + offsetPx * layerFactors[s.layer] + Math.sin(elapsed * s.swaySpeed * 2 + s.phase) * s.swayAmp, width);
        const tw = 0.55 + 0.45 * Math.sin(elapsed * s.twinkleSpeed * 2 + s.phase);
        const alpha = Math.max(s.baseAlpha * tw, 0);
        ctx.beginPath();
        ctx.arc(x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.gold ? `rgba(232, 201, 106, ${alpha})` : `rgba(255, 255, 255, ${alpha * 0.8})`;
        ctx.fill();
        if (s.flare && tw > 0.82) {
          const len = s.r * 3.2;
          const strength = ((tw - 0.82) / 0.18) * alpha * 0.9;
          drawCross(s.gold ? sprites.crossGold : sprites.crossWhite, x, s.y, len, strength);
        }
      });

      yawBase += (-(parallaxRef.current - 1.5) * 0.9 - yawBase) * Math.min(1, dt * 2);
      drawDome(yawBase + elapsed * 0.004);

      meteors = meteors.filter((m) => {
        m.life += dt;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        const progress = m.life / m.ttl;
        if (progress >= 1) return false;
        const env = Math.sin(Math.PI * progress);
        const mx = m.x + offsetPx * 0.8;
        const tailX = mx - m.vx * 0.4;
        const tailY = m.y - m.vy * 0.4;
        const grad = ctx.createLinearGradient(mx, m.y, tailX, tailY);
        grad.addColorStop(0, `rgba(255, 244, 214, ${0.85 * env})`);
        grad.addColorStop(0.35, `rgba(232, 201, 106, ${0.55 * env})`);
        grad.addColorStop(1, 'rgba(232, 201, 106, 0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.fire ? 2.2 : 1.6;
        ctx.beginPath();
        ctx.moveTo(mx, m.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
        drawGlow(sprites.glowWhite, mx, m.y, m.fire ? 6 : 4, 0.9 * env);
        if (m.fire && sparks.length < MAX_SPARKS) {
          const n = Math.min(2, MAX_SPARKS - sparks.length);
          for (let k = 0; k < n; k++) {
            sparks.push({
              x: m.x + (Math.random() - 0.5) * 4,
              y: m.y + (Math.random() - 0.5) * 4,
              vx: m.vx * 0.08 + (Math.random() - 0.5) * 36,
              vy: m.vy * 0.08 + 8 + Math.random() * 26,
              life: 0,
              ttl: 0.3 + Math.random() * 0.4,
            });
          }
        }
        return true;
      });

      sparks = sparks.filter((s) => {
        s.life += dt;
        if (s.life >= s.ttl) return false;
        s.vy += 60 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const env = 1 - s.life / s.ttl;
        ctx.beginPath();
        ctx.arc(s.x + offsetPx * 0.8, s.y, 0.8 + env * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = Math.random() < 0.3
          ? `rgba(255, 244, 214, ${0.7 * env})`
          : `rgba(232, 201, 106, ${0.6 * env})`;
        ctx.fill();
        return true;
      });

      nextMeteor -= dt;
      if (nextMeteor <= 0) {
        spawnMeteor();
        if (Math.random() < 0.3) spawnMeteor();
        nextMeteor = 2.5 + Math.random() * 2.5;
      }

      showerTimer -= dt;
      if (showerTimer <= 0) {
        const count = 6 + Math.floor(Math.random() * 3);
        const rx = width * (0.1 + Math.random() * 0.8);
        const ry = height * Math.random() * 0.25;
        for (let i = 0; i < count; i++) showerQueue.push({ delay: Math.random() * 2.6, x: rx, y: ry });
        showerTimer = 55 + Math.random() * 40;
      }
      showerQueue = showerQueue.filter((item) => {
        item.delay -= dt;
        if (item.delay <= 0) {
          spawnMeteor({ x: item.x, y: item.y });
          return false;
        }
        return true;
      });

      ctx.globalCompositeOperation = 'source-over';
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

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" />;
};

export default TarotParticles;
