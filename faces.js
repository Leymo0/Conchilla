// Avatars: six emoticon faces, drawn as neon line art in each person's colour.
// Colours are unique inside a room — the host hands them out.

const FACES = {
  cat:   { label: ':3' },
  smile: { label: ':)' },
  cry:   { label: ":'(" },
  evil:  { label: '>:)' },
  angry: { label: '>:(' },
  grin:  { label: ':D' },
};

const COLORS = {
  cyan:    '#19f0ff',
  magenta: '#ff3df5',
  lime:    '#a6ff3d',
  yellow:  '#ffe53d',
  orange:  '#ff8f2e',
  violet:  '#a77bff',
  pink:    '#ff6fae',
  mint:    '#3dffbb',
  blue:    '#4d8bff',
  red:     '#ff4d5e',
  gold:    '#ffc23d',
  ice:     '#d8f6ff',
};
const COLOR_ORDER = Object.keys(COLORS);

// Inner drawing for each face, in a 100×100 box, stroked with currentColor
const FACE_PARTS = {
  cat: `
    <circle cx="34" cy="42" r="6" fill="currentColor" stroke="none"/>
    <circle cx="66" cy="42" r="6" fill="currentColor" stroke="none"/>
    <path d="M34 62 Q42 73 50 62 Q58 73 66 62"/>`,
  smile: `
    <circle cx="34" cy="40" r="6" fill="currentColor" stroke="none"/>
    <circle cx="66" cy="40" r="6" fill="currentColor" stroke="none"/>
    <path d="M30 59 Q50 80 70 59"/>`,
  cry: `
    <circle cx="34" cy="40" r="6" fill="currentColor" stroke="none"/>
    <circle cx="66" cy="40" r="6" fill="currentColor" stroke="none"/>
    <path d="M32 74 Q50 57 68 74"/>
    <path d="M27 50 Q21 60 27 64 Q33 60 27 50 Z" fill="currentColor" fill-opacity=".55" stroke-width="3"/>`,
  evil: `
    <path d="M22 26 L42 36"/><path d="M78 26 L58 36"/>
    <circle cx="36" cy="46" r="5.5" fill="currentColor" stroke="none"/>
    <circle cx="64" cy="46" r="5.5" fill="currentColor" stroke="none"/>
    <path d="M28 62 Q50 82 72 62"/><path d="M28 62 L24 58"/><path d="M72 62 L76 58"/>`,
  angry: `
    <path d="M22 26 L42 36"/><path d="M78 26 L58 36"/>
    <circle cx="36" cy="46" r="5.5" fill="currentColor" stroke="none"/>
    <circle cx="64" cy="46" r="5.5" fill="currentColor" stroke="none"/>
    <path d="M32 76 Q50 60 68 76"/>`,
  grin: `
    <path d="M27 42 Q34 33 41 42"/><path d="M59 42 Q66 33 73 42"/>
    <path d="M28 56 H72 Q72 82 50 82 Q28 82 28 56 Z" fill="currentColor" fill-opacity=".9"/>
    <path d="M34 56 V62 M66 56 V62" stroke="#031014" stroke-width="3"/>`,
};

// Only our palette names or a plain #rrggbb — anything else (sent by someone else) is ignored
const colorHex = (c) => COLORS[c] || (/^#[0-9a-fA-F]{6}$/.test(c) ? c : COLORS.cyan);

// Full avatar tile as an SVG string
function faceSvg(face, color, size = 48, opts = {}) {
  const hex = colorHex(color);
  const parts = FACE_PARTS[face] || FACE_PARTS.smile;
  const glow = opts.glow === false ? '' : `filter:drop-shadow(0 0 ${Math.max(2, size / 14)}px ${hex}aa);`;
  return `<svg class="face" viewBox="0 0 100 100" width="${size}" height="${size}" style="color:${hex};${glow}" aria-hidden="true">
    <rect x="5" y="5" width="90" height="90" rx="22" fill="#031014" stroke="currentColor" stroke-width="4"/>
    <rect x="11" y="11" width="78" height="78" rx="17" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <g fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">${parts}</g>
  </svg>`;
}

// Next free colour, preferring the one the person asked for
function pickColor(preferred, taken) {
  if (preferred && COLORS[preferred] && !taken.has(preferred)) return preferred;
  return COLOR_ORDER.find((c) => !taken.has(c)) || null;
}

if (typeof module !== 'undefined') module.exports = { FACES, COLORS, COLOR_ORDER, faceSvg, pickColor, colorHex };
