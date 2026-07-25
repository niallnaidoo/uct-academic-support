/* ─── Shared atom components ─── */

import { useState, useEffect, useRef } from 'react';

/* ─── Icons (inline, no external deps) ─── */
export const Icon = {
  Dashboard: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  Clubs: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="5.5" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M1 13c.5-2 2.5-3 4.5-3s4 1 4.5 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10 13c.3-1.5 1.5-2.3 3-2.3s2.6.8 3 2.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Form: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6 6h4M6 9h4M6 12h2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Upload: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 10V3M5 6l3-3 3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Star: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2l1.8 4.2 4.2.4-3.2 2.8 1 4.4L8 11.5 4.2 13.8l1-4.4L2 6.6l4.2-.4L8 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Check: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Alert: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5L14.5 13H1.5L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 6.5v3M8 11.3v.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Doc: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M4 1.5h6L13 4.5V14a.5.5 0 01-.5.5h-8A.5.5 0 014 14V1.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M10 1.5V5h3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 8h4M6 11h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Plus: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  Arrow: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Bell: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3 11h10l-1.5-2V6.5a3.5 3.5 0 10-7 0V9L3 11z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 13a1.5 1.5 0 003 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Download: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3v7M5 8l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 13h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Money: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="4" width="13" height="8" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  Field: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="10" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <ellipse cx="8" cy="8" rx="3.5" ry="2.2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="0.7" fill="currentColor" />
    </svg>
  ),
  Whistle: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="9" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10 9h4.5l-1.5-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="9" r="1" fill="currentColor" />
    </svg>
  ),
  Live: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" opacity="0.2" />
    </svg>
  ),
  Shield: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5L2.5 3.5V8c0 3.5 2.4 5.5 5.5 6.5 3.1-1 5.5-3 5.5-6.5V3.5L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Eye: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  Mail: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="10" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 4l6 5 6-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  X: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Clock: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Users: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M1.5 13.5c.4-2.2 2.3-3.4 4.5-3.4s4.1 1.2 4.5 3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M11 4.2a2.2 2.2 0 010 4.2M12.5 13.5c-.2-1.6-1-2.7-2.2-3.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
};

/* ─── Atoms ─── */

export function Pill({ tone = 'muted', children, dot }) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot && <span className={`sdot ${tone}`} />}
      {children}
    </span>
  );
}

export function Btn({ tone = 'outline', size, icon: I, children, onClick, ...rest }) {
  const cls = `btn btn-${tone}${size === 'sm' ? ' btn-sm' : ''}`;
  return (
    <button className={cls} onClick={onClick} {...rest}>
      {I && <I />}
      {children}
    </button>
  );
}

export function Card({ title, sub, action, children, style }) {
  return (
    <div className="card" style={style}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  );
}

// Centered empty-state card — shared by admin pages that can render with no data
// (blank cohort: clubs, fixtures, affiliations, docs, CQI). Uses the .club-fix-empty
// design-system classes so every empty surface looks identical.
export function EmptyState({ icon: I, title, sub, action }) {
  return (
    <div className="club-fix-empty">
      {I && (
        <div className="club-fix-empty-icon">
          <I />
        </div>
      )}
      <div className="club-fix-empty-title">{title}</div>
      {sub && <div className="club-fix-empty-sub">{sub}</div>}
      {action}
    </div>
  );
}

/**
 * A tiny inline trend line for a KPI card (StackAI pattern). Pure SVG, no deps.
 * `data` is a series of numbers; it's normalised to the card's little viewport.
 */
export function Sparkline({ data, tone = 'teal', width = 96, height = 28 }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return [x, y];
  });
  const d = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const area = `${d} L${width} ${height} L0 ${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  const stroke = `var(--${tone === 'teal' ? 'green-mid' : tone === 'amber' ? 'gold-warm' : tone === 'red' ? 'coral' : 'green-mid'})`;
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <path d={area} fill={stroke} opacity="0.08" />
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lx} cy={ly} r="2" fill={stroke} />
    </svg>
  );
}

/**
 * A KPI stat card. Optionally carries a `trend` (number series → sparkline) and a
 * `delta` chip (e.g. "+12%"), mirroring the analytics dashboards on Mobbin.
 */
export function KPI({ label, num, sub, tone = '', trend, trendTone, delta, deltaTone = 'up' }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-l">{label}</div>
      <div className="kpi-n-row">
        <div className="kpi-n">{num}</div>
        {delta != null && <span className={`kpi-delta ${deltaTone}`}>{delta}</span>}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {trend && (
        <div className="kpi-spark">
          <Sparkline data={trend} tone={trendTone ?? (tone === 'amber' ? 'amber' : 'teal')} />
        </div>
      )}
    </div>
  );
}

/**
 * A monogram avatar derived from a name — initials on a deterministic colour.
 * Used across the rosters (Deel pattern: avatar + name + subtitle per row).
 */
const AVATAR_COLORS = ['#16273F', '#215F47', '#B89B4A', '#D85A30', '#2C4667', '#4B8A6C', '#8A6E1C'];
export function Avatar({ name, size = 30 }) {
  const initials = String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  let h = 0;
  for (let i = 0; i < String(name || '').length; i++) h = (h * 31 + String(name).charCodeAt(i)) | 0;
  const bg = AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  return (
    <div
      className="avatar"
      style={{ background: bg, width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </div>
  );
}

/**
 * A row of filter chips (Deel pattern). Each chip is a labelled dropdown; the
 * "all" value reads as the bare label, a selection reads "Label: value" and
 * highlights. `chips` is [{ key, label, value, options: [{value,label}], onChange }].
 */
export function FilterChips({ chips, right }) {
  return (
    <div className="chip-row">
      {chips.map((c) => {
        const active = c.value && c.value !== 'all';
        const current = active ? c.options.find((o) => o.value === c.value)?.label : null;
        return (
          <label key={c.key} className={`chip ${active ? 'on' : ''}`}>
            <span className="chip-label">
              {c.label}
              {current ? `: ${current}` : ''}
            </span>
            <select value={c.value} onChange={(e) => c.onChange(e.target.value)}>
              {c.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronDown />
          </label>
        );
      })}
      {right}
    </div>
  );
}

function ChevronDown() {
  return (
    <svg className="chip-caret" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A single stacked proportion bar — shows how a total splits across categories
 * (e.g. the RAG risk distribution). `segments` is [{ value, tone, label }].
 * Real data only; unlike a sparkline it needs no time series.
 */
export function SegmentBar({ segments, showLegend = true }) {
  const total = segments.reduce((n, s) => n + (s.value || 0), 0) || 1;
  return (
    <div className="segbar-wrap">
      <div
        className="segbar"
        role="img"
        aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}
      >
        {segments.map((s) =>
          s.value > 0 ? (
            <div
              key={s.label}
              className={`segbar-seg tone-${s.tone}`}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value}`}
            />
          ) : null,
        )}
      </div>
      {showLegend && (
        <div className="segbar-legend">
          {segments.map((s) => (
            <span key={s.label} className="segbar-key">
              <i className={`dot tone-${s.tone}`} />
              {s.label} <strong>{s.value}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A "Showing N of M" count line for a roster header. */
export function ResultCount({ shown, total, noun = 'result' }) {
  const plural = total === 1 ? noun : `${noun}s`;
  return (
    <div className="result-count">
      {shown === total ? (
        <>
          {total} {plural}
        </>
      ) : (
        <>
          {shown} of {total} {plural}
        </>
      )}
    </div>
  );
}

export function ProgressBar({ value, tone }) {
  return (
    <div className="pbar">
      <div
        className={`pbar-fill ${tone || ''}`}
        style={{ width: Math.min(100, Math.max(0, value)) + '%' }}
      />
    </div>
  );
}

export function ProgChip({ value, tone = 'teal' }) {
  return (
    <div className="prog-chip">
      <div className="prog-chip-bar">
        <div
          className="prog-chip-fill"
          style={{ width: value + '%', background: `var(--${tone})` }}
        />
      </div>
      <div className="prog-chip-num">{value}%</div>
    </div>
  );
}

export function SchoolAvatar({ school, size = 30 }) {
  const initials = school.name
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('');
  return (
    <div
      className="club-avatar"
      style={{ background: school.color, width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials}
    </div>
  );
}

export function SchoolNameCell({ school }) {
  return (
    <div className="club-name-cell">
      <SchoolAvatar school={school} />
      <div>
        <div className="club-name">{school.name}</div>
        <div className="club-district">{school.town}</div>
      </div>
    </div>
  );
}

/* yes/no segmented — conditional colours + icons in active state */
export function YN({ value, onChange }) {
  return (
    <div className="seg">
      <button
        className={`seg-btn ${value === true ? 'on yes' : ''}`}
        onClick={() => onChange(true)}
      >
        {value === true && <Icon.Check />}
        <span>Yes</span>
      </button>
      <button
        className={`seg-btn ${value === false ? 'on no' : ''}`}
        onClick={() => onChange(false)}
      >
        {value === false && <Icon.X />}
        <span>No</span>
      </button>
    </div>
  );
}

/* legacy stepper (kept for direct callers) */
export function NumStep({ value, onChange, min = 0, max = 99 }) {
  return (
    <input
      className="num-input"
      type="number"
      min={min}
      max={max}
      value={value ?? ''}
      onChange={(e) =>
        onChange(
          e.target.value === '' ? '' : Math.max(min, Math.min(max, parseInt(e.target.value) || 0)),
        )
      }
    />
  );
}

/* Choice — segmented control for arbitrary string options (used by CQI subscription cycle) */
export function Choice({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map((opt) => (
        <button
          key={opt}
          className={`seg-btn ${value === opt ? 'on yes' : ''}`}
          onClick={() => onChange(opt)}
        >
          {value === opt && <Icon.Check />}
          <span>{opt}</span>
        </button>
      ))}
    </div>
  );
}

/* Money — currency input with prefix and value formatting */
export function MoneyInput({ value, onChange, currency = 'R', suffix = '/ member' }) {
  return (
    <div className="money-input">
      <span className="money-currency">{currency}</span>
      <input
        type="number"
        min="0"
        step="any"
        className="money-field"
        placeholder="0"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : parseFloat(e.target.value) || 0)}
      />
      <span className="money-suffix">{suffix}</span>
    </div>
  );
}

/* slider input — used in CQI for capped quantities (teams, coaches, fields, %) */
export function NumSlider({ value, onChange, min = 0, max = 10, suffix }) {
  const v = value === '' || value == null ? 0 : Math.max(min, Math.min(max, parseInt(value) || 0));
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  return (
    <div className="num-slider" style={{ '--pct': pct + '%' }}>
      <input
        type="range"
        min={min}
        max={max}
        value={v}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="num-slider-input"
        aria-label={`Value between ${min} and ${max}`}
      />
      <div className="num-slider-val">
        <span className="num-slider-num">
          {v}
          {suffix || ''}
        </span>
        <span className="num-slider-max">
          / {max}
          {suffix || ''}
        </span>
      </div>
    </div>
  );
}

/* CountUp — animates smoothly between previous + new target, with a setTimeout fallback so the value lands even if rAF is throttled (background tabs, headless contexts). */
export function CountUp({ to, duration = 900, decimals = 0, suffix = '' }) {
  const target = Number(to) || 0;
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);
  const fallbackRef = useRef(null);
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    clearTimeout(fallbackRef.current);
    const from = fromRef.current;
    if (from === target) {
      setVal(target);
      return;
    }
    const start = performance.now();
    const animate = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (target - from) * eased;
      fromRef.current = v;
      setVal(v);
      if (t < 1) rafRef.current = requestAnimationFrame(animate);
      else {
        fromRef.current = target;
        setVal(target);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    // Safety net — guarantees the value lands at target even when rAF is throttled
    fallbackRef.current = setTimeout(() => {
      cancelAnimationFrame(rafRef.current);
      fromRef.current = target;
      setVal(target);
    }, duration + 80);
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(fallbackRef.current);
    };
  }, [target, duration]);
  if (decimals === 0)
    return (
      <>
        {Math.round(val)}
        {suffix}
      </>
    );
  return (
    <>
      {val.toFixed(decimals)}
      {suffix}
    </>
  );
}

/* statusFor — picks "good"/"warn"/"danger" tone based on a percentage value */
export function statusFor(value, goodAt = 70, warnAt = 40) {
  if (value >= goodAt) return 'good';
  if (value >= warnAt) return 'warn';
  return 'danger';
}

/* Simulated toast */
/* Close-on-Escape hook for modals/overlays. */
export function useEscapeClose(onClose) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
}

export function useToast() {
  const [msg, setMsg] = useState(null);
  const [tone, setTone] = useState('ok');
  // Optional inline action (e.g. an Undo button) carried by a toast.
  const [action, setAction] = useState(null);
  // Single timer ref so a new toast clears any pending dismissal — otherwise the
  // previous toast's timeout could clear a fresh message early, or leave a stale
  // action button rendered on an unrelated message.
  const timer = useRef(null);
  function clear() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setMsg(null);
    setAction(null);
  }
  function show(m, t = 'ok', act = null) {
    if (timer.current) clearTimeout(timer.current);
    setMsg(m);
    setTone(t);
    setAction(act);
    // Give action toasts longer so there's time to click (e.g. Undo).
    timer.current = setTimeout(clear, act ? 6000 : 2400);
  }
  const node = msg ? (
    // role=status + aria-live so the message — and any Undo action — is announced
    // to screen-reader / keyboard users before the toast auto-dismisses.
    <div
      role="status"
      aria-live="polite"
      className={`toast show ${tone}`}
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 999,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontFamily: "'Montserrat',sans-serif",
        fontSize: 12,
        fontWeight: 500,
        padding: '10px 18px',
        borderRadius: 8,
        background: tone === 'ok' ? 'var(--teal)' : tone === 'warn' ? 'var(--gold)' : 'var(--ink)',
        color: tone === 'warn' ? 'var(--ink)' : '#fff',
      }}
    >
      <span>{msg}</span>
      {action && (
        <button
          type="button"
          // Clear THIS toast first, then run the handler — which may itself raise a
          // new toast (e.g. Undo → reciprocal Undo). React batches both state
          // updates in this handler, so the new toast wins cleanly.
          onClick={() => {
            clear();
            action.onClick && action.onClick();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '2px 4px',
            margin: 0,
            cursor: 'pointer',
            font: 'inherit',
            fontWeight: 700,
            color: 'inherit',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
            opacity: 0.95,
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  ) : null;
  return [show, node];
}
