// Accent color themes for the CLI. The accent is used for branding marks
// (banner border, ✻ Sennoric wordmark, News header, model name).

export const THEMES = {
  ember:  { accent: '#cc785c', desc: 'warm clay — the default' },
  violet: { accent: '#a78bfa', desc: 'soft purple, matches Fresco' },
  ocean:  { accent: '#60a5fa', desc: 'calm blue' },
  jade:   { accent: '#34d399', desc: 'green terminal classic' },
  rose:   { accent: '#fb7185', desc: 'warm pink' },
  gold:   { accent: '#fbbf24', desc: 'amber' },
};

let _current = 'ember';

export function setTheme(name) {
  if (!THEMES[name]) return false;
  _current = name;
  return true;
}

export function themeName() { return _current; }
export function accent()    { return THEMES[_current].accent; }
