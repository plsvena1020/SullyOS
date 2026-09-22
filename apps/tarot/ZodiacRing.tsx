import React from 'react';

const SIGNS = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];

interface Props {
  size: number;
  durationS?: number;
  reverse?: boolean;
  glyphColor?: string;
  className?: string;
}

/** 黄道十二宫符号环：极淡旋转的装饰环，绝对定位于父容器中心。 */
export const ZodiacRing: React.FC<Props> = ({
  size,
  durationS = 140,
  reverse = false,
  glyphColor = 'rgba(201,162,39,0.9)',
  className = '',
}) => (
  <div
    aria-hidden
    className={`tarot-ring-spin pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${className}`}
    style={{
      width: size,
      height: size,
      animationDuration: `${durationS}s`,
      animationDirection: reverse ? 'reverse' : undefined,
    }}
  >
    {SIGNS.map((sign, i) => (
      <span
        key={sign}
        className="absolute left-1/2 top-1/2 font-serif leading-none"
        style={{
          fontSize: Math.max(9, Math.round(size * 0.055)),
          color: glyphColor,
          transform: `translate(-50%,-50%) rotate(${i * 30}deg) translateY(-${size / 2}px) rotate(-${i * 30}deg)`,
        }}
      >
        {sign}
      </span>
    ))}
  </div>
);

export default ZodiacRing;
