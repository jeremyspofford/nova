/** Space-separated RGB triplets for each Tailwind shade */
export type ColorScale = {
  50: string; 100: string; 200: string; 300: string; 400: string
  500: string; 600: string; 700: string; 800: string; 900: string; 950: string
}

// ── Accent palettes ──────────────────────────────────────────────────────────

export const accentPalettes: Record<string, ColorScale> = {
  // Custom Nova teal (500 = #19A89E) — NOT stock Tailwind teal. See
  // DESIGN.md "Nova Teal (Primary Accent)" and index.css :root
  // --accent-50..950. The historical stock-teal default here was a bug
  // (see DESIGN.md "Rebuild amendments"); stock teal lives on below as
  // `tailwind-teal` for anyone who wants it.
  teal: {
    50: '236 253 249', 100: '204 251 240', 200: '150 243 227',
    300: '92 232 208',  400: '36 201 184',  500: '25 168 158',
    600: '22 142 133',  700: '20 116 108',  800: '17 93 87',
    900: '16 77 72',    950: '8 45 42',
  },
  'tailwind-teal': {
    50: '240 253 250', 100: '204 251 241', 200: '153 246 228',
    300: '94 234 212',  400: '45 212 191',  500: '20 184 166',
    600: '13 148 136',  700: '15 118 110',  800: '17 94 89',
    900: '19 78 74',    950: '4 47 46',
  },
  blue: {
    50: '239 246 255', 100: '219 234 254', 200: '191 219 254',
    300: '147 197 253', 400: '96 165 250',  500: '59 130 246',
    600: '37 99 235',   700: '29 78 216',   800: '30 64 175',
    900: '30 58 138',   950: '23 37 84',
  },
  purple: {
    50: '250 245 255', 100: '243 232 255', 200: '233 213 255',
    300: '216 180 254', 400: '192 132 252', 500: '168 85 247',
    600: '147 51 234',  700: '126 34 206',  800: '107 33 168',
    900: '88 28 135',   950: '59 7 100',
  },
  rose: {
    50: '255 241 242', 100: '255 228 230', 200: '254 205 211',
    300: '253 164 175', 400: '251 113 133', 500: '244 63 94',
    600: '225 29 72',   700: '190 18 60',   800: '159 18 57',
    900: '136 19 55',   950: '76 5 25',
  },
  indigo: {
    50: '238 242 255', 100: '224 231 255', 200: '199 210 254',
    300: '165 180 252', 400: '129 140 248', 500: '99 102 241',
    600: '79 70 229',   700: '67 56 202',   800: '55 48 163',
    900: '49 46 129',   950: '30 27 75',
  },
  cyan: {
    50: '236 254 255', 100: '207 250 254', 200: '165 243 252',
    300: '103 232 249', 400: '34 211 238',  500: '6 182 212',
    600: '8 145 178',   700: '14 116 144',  800: '21 94 117',
    900: '22 78 99',    950: '8 51 68',
  },
  orange: {
    50: '255 247 237', 100: '255 237 213', 200: '254 215 170',
    300: '253 186 116', 400: '251 146 60',  500: '249 115 22',
    600: '234 88 12',   700: '194 65 12',   800: '154 52 18',
    900: '124 45 18',   950: '67 20 7',
  },
  emerald: {
    50: '236 253 245', 100: '209 250 229', 200: '167 243 208',
    300: '110 231 183', 400: '52 211 153',  500: '16 185 129',
    600: '5 150 105',   700: '4 120 87',    800: '6 95 70',
    900: '6 78 59',     950: '2 44 34',
  },

  violet: {
    50: '245 243 255', 100: '237 233 254', 200: '221 214 254',
    300: '196 181 253', 400: '167 139 250', 500: '139 92 246',
    600: '124 58 237',  700: '109 40 217',  800: '91 33 182',
    900: '76 29 149',   950: '46 16 101',
  },
  amber: {
    50: '255 251 235', 100: '254 243 199', 200: '253 230 138',
    300: '252 211 77',  400: '251 191 36',  500: '245 158 11',
    600: '217 119 6',   700: '180 83 9',    800: '146 64 14',
    900: '120 53 15',   950: '69 26 3',
  },

  // ── Community theme accents ──────────────────────────────────────────────

  'nord-frost': {
    50: '240 248 250', 100: '220 238 245', 200: '200 225 235',
    300: '170 210 220', 400: '143 188 187', 500: '136 192 208',
    600: '129 161 193', 700: '94 129 172',  800: '65 90 135',
    900: '50 70 110',   950: '30 50 80',
  },
  'ctp-blue': {
    50: '245 248 255', 100: '230 240 255', 200: '210 225 254',
    300: '185 210 253', 400: '160 195 252', 500: '137 180 250',
    600: '100 145 230', 700: '70 110 200',  800: '50 85 160',
    900: '30 60 120',   950: '20 40 80',
  },
  'ctp-latte-blue': {
    50: '235 242 255', 100: '215 228 254', 200: '185 205 252',
    300: '145 175 249', 400: '100 140 248', 500: '30 102 245',
    600: '25 85 210',   700: '20 70 175',   800: '18 55 140',
    900: '15 45 110',   950: '10 30 75',
  },
  'dracula-purple': {
    50: '250 245 255', 100: '245 238 255', 200: '235 220 253',
    300: '220 200 252', 400: '205 175 251', 500: '189 147 249',
    600: '160 115 240', 700: '130 80 210',  800: '100 55 170',
    900: '70 35 130',   950: '50 20 90',
  },
  'tokyo-blue': {
    50: '245 248 255', 100: '230 238 255', 200: '210 220 253',
    300: '180 200 251', 400: '150 180 249', 500: '122 162 247',
    600: '95 135 235',  700: '70 110 210',  800: '50 80 165',
    900: '35 55 120',   950: '20 35 80',
  },
  'gruvbox-orange': {
    50: '255 245 225', 100: '255 235 195', 200: '254 210 150',
    300: '254 180 100', 400: '254 155 60',  500: '254 128 25',
    600: '230 115 22',  700: '194 65 12',   800: '165 70 15',
    900: '120 48 10',   950: '80 30 5',
  },
  'solarized-cyan': {
    50: '238 252 250', 100: '215 245 242', 200: '175 230 225',
    300: '130 215 210', 400: '90 200 190',  500: '60 180 170',
    600: '42 161 152',  700: '30 130 120',  800: '22 100 95',
    900: '15 70 65',    950: '10 45 40',
  },
  'one-blue': {
    50: '240 248 255', 100: '220 238 254', 200: '195 218 252',
    300: '160 195 250', 400: '130 170 248', 500: '97 175 239',
    600: '75 145 215',  700: '55 115 185',  800: '40 90 155',
    900: '28 65 120',   950: '18 40 80',
  },
}

// ── Neutral palettes ─────────────────────────────────────────────────────────

export const neutralPalettes: Record<string, ColorScale> = {
  // The Nova set. Each is a whole neutral family with its own cast — warm,
  // cool, violet, ember, paper — because a theme that only swaps the accent
  // leaves nine tenths of the screen identical (the complaint that started
  // the 2026-09 redesign). `stone` is the warm family from DESIGN.md; the
  // previous entry under this name held a cool grey (800 = 36 36 44) that
  // was neither stone nor anything else.
  stone: {
    50: '250 250 249', 100: '245 245 244', 200: '231 229 228',
    300: '214 211 209', 400: '168 162 158', 500: '120 113 108',
    600: '87 83 78',    700: '68 64 60',    800: '41 37 36',
    900: '28 25 23',    950: '12 10 9',
  },
  slate: {
    50: '246 248 250',  100: '238 243 248', 200: '220 228 236',
    300: '190 202 214', 400: '147 163 181', 500: '92 108 126',
    600: '74 90 108',   700: '44 56 70',    800: '28 37 49',
    900: '19 26 36',    950: '11 15 23',
  },
  nebula: {
    50: '248 245 255',  100: '243 238 255', 200: '228 220 247',
    300: '201 191 227', 400: '169 155 203', 500: '110 96 145',
    600: '84 70 122',   700: '53 41 90',    800: '31 24 56',
    900: '21 16 42',    950: '10 7 20',
  },
  ember: {
    50: '253 249 243',  100: '251 244 234', 200: '240 228 211',
    300: '214 196 172', 400: '184 158 128', 500: '122 100 78',
    600: '100 82 62',   700: '67 48 28',    800: '38 26 16',
    900: '25 18 12',    950: '11 8 6',
  },
  daylight: {
    50: '244 241 234',  100: '236 231 221', 200: '214 207 194',
    300: '190 182 170', 400: '133 124 114', 500: '95 87 79',
    600: '75 68 61',    700: '58 52 47',    800: '41 37 34',
    900: '28 25 23',    950: '18 16 14',
  },
  zinc: {
    50: '250 250 250', 100: '244 244 245', 200: '228 228 231',
    300: '212 212 216', 400: '161 161 170', 500: '113 113 122',
    600: '82 82 91',    700: '63 63 70',    800: '39 39 42',
    900: '24 24 27',    950: '6 6 10',
  },
  gray: {
    50: '249 250 251', 100: '243 244 246', 200: '229 231 235',
    300: '209 213 219', 400: '156 163 175', 500: '107 114 128',
    600: '75 85 99',    700: '55 65 81',    800: '31 41 55',
    900: '17 24 39',    950: '2 4 12',
  },

  // ── Community theme neutrals ─────────────────────────────────────────────

  nord: {
    50: '242 244 248', 100: '236 239 244', 200: '229 233 240',
    300: '216 222 233', 400: '160 170 190', 500: '130 140 160',
    600: '100 110 130', 700: '76 86 106',   800: '67 76 94',
    900: '40 46 60',    950: '22 26 36',
  },
  'ctp-mocha': {
    50: '225 230 248', 100: '205 214 244', 200: '186 194 222',
    300: '166 173 200', 400: '147 153 178', 500: '108 112 134',
    600: '88 91 112',   700: '69 71 90',    800: '49 50 68',
    900: '30 30 46',    950: '17 17 27',
  },
  'ctp-latte': {
    50: '239 241 245', 100: '230 233 239', 200: '220 224 232',
    300: '204 208 218', 400: '172 176 190', 500: '140 143 161',
    600: '108 111 133', 700: '76 79 105',   800: '55 58 80',
    900: '40 42 60',    950: '25 26 40',
  },
  dracula: {
    50: '248 248 242', 100: '240 240 238', 200: '220 222 230',
    300: '195 200 220', 400: '165 170 195', 500: '130 140 175',
    600: '98 114 164',  700: '83 86 105',   800: '68 71 90',
    900: '30 32 44',    950: '16 16 24',
  },
  'tokyo-night': {
    50: '240 242 248', 100: '220 225 240', 200: '195 202 228',
    300: '169 177 214', 400: '145 155 195', 500: '120 130 170',
    600: '86 95 137',   700: '55 60 85',    800: '36 40 59',
    900: '26 27 38',    950: '18 18 28',
  },
  gruvbox: {
    50: '253 246 220', 100: '251 241 199', 200: '235 219 178',
    300: '213 196 161', 400: '189 174 147', 500: '168 153 132',
    600: '124 111 100', 700: '102 92 84',   800: '80 73 69',
    900: '42 40 38',    950: '24 22 18',
  },
  solarized: {
    50: '253 249 237', 100: '253 246 227', 200: '238 232 213',
    300: '200 195 180', 400: '147 161 161', 500: '131 148 150',
    600: '101 123 131', 700: '88 110 117',  800: '7 54 66',
    900: '0 32 42',     950: '0 20 28',
  },
  'one-dark': {
    50: '240 242 248', 100: '225 228 238', 200: '200 205 220',
    300: '171 178 191', 400: '140 148 165', 500: '108 117 134',
    600: '92 99 112',   700: '76 82 99',    800: '53 59 69',
    900: '30 34 42',    950: '18 20 26',
  },
}

// ── Card surface colors per neutral palette ──────────────────────────────────
// Light-mode card surface: pure white for standard palettes, tinted for themes
// Keyed by neutral palette name

export const cardSurface: Record<string, { light: string; dark: string }> = {
  stone:        { light: '255 255 255', dark: '33 30 28'  },
  slate:        { light: '255 255 255', dark: '24 32 43'  },
  nebula:       { light: '255 255 255', dark: '26 20 49'  },
  ember:        { light: '255 255 255', dark: '31 22 14'  },
  daylight:     { light: '252 250 246', dark: '33 30 28'  },
  zinc:         { light: '255 255 255', dark: '18 18 22'  },
  gray:         { light: '255 255 255', dark: '14 18 30'  },
  nord:         { light: '236 239 244', dark: '40 46 60'  },
  'ctp-mocha':  { light: '255 255 255', dark: '30 30 46'  },
  'ctp-latte':  { light: '239 241 245', dark: '55 58 80'  },
  dracula:      { light: '255 255 255', dark: '30 32 44'  },
  'tokyo-night':{ light: '255 255 255', dark: '36 40 59'  },
  gruvbox:      { light: '251 241 199', dark: '42 40 38'  },
  solarized:    { light: '253 246 227', dark: '4 38 50'   },
  'one-dark':   { light: '255 255 255', dark: '30 34 42'  },
}

// ── Theme presets ────────────────────────────────────────────────────────────

export interface ThemePreset {
  label: string
  /** One line for the picker: what the theme is, in the operator's terms. */
  description: string
  accent: string
  neutral: string
  /** A second accent family (its 950 tints the lower atmosphere in dark
   *  mode, its 200 in light) — Nova's amber, per DESIGN.md. Absent = the
   *  accent tints everything, which is how the community themes stay
   *  faithful to their sources. */
  secondary?: string
  /** A theme that IS light or IS dark: picking it brings its mode along.
   *  Absent = renders in whichever mode the operator has. */
  preferredMode?: 'light' | 'dark'
  group: 'nova' | 'community' | 'custom'
}

/** What every browser starts on until told otherwise. */
export const DEFAULT_PRESET = 'nova'

export const themePresets: Record<string, ThemePreset> = {
  // The Nova set — five deliberately different hue families on the SAME
  // chrome, so the choice reads at a glance.
  nova: {
    label: 'Nova', description: 'Teal on warm near-black; amber for attention.',
    accent: 'teal', neutral: 'stone', secondary: 'amber', group: 'nova',
  },
  slate: {
    label: 'Slate', description: 'Blue on cool slate — the workbench.',
    accent: 'blue', neutral: 'slate', group: 'nova',
  },
  nebula: {
    label: 'Nebula', description: 'Violet on deep indigo with a magenta glow.',
    accent: 'violet', neutral: 'nebula', secondary: 'rose', group: 'nova',
  },
  ember: {
    label: 'Ember', description: 'Amber on black, warm all the way down.',
    accent: 'amber', neutral: 'ember', secondary: 'orange', preferredMode: 'dark', group: 'nova',
  },
  daylight: {
    label: 'Daylight', description: 'Warm paper with the Nova teal — for a bright room.',
    accent: 'teal', neutral: 'daylight', secondary: 'amber', preferredMode: 'light', group: 'nova',
  },

  // Community
  nord:           { label: 'Nord',             description: 'Arctic blues on a cool grey.',      accent: 'nord-frost',      neutral: 'nord',         preferredMode: 'dark',  group: 'community' },
  'ctp-mocha':    { label: 'Catppuccin Mocha', description: 'Soft pastels on mocha.',           accent: 'ctp-blue',        neutral: 'ctp-mocha',    preferredMode: 'dark',  group: 'community' },
  'ctp-latte':    { label: 'Catppuccin Latte', description: 'The light Catppuccin.',            accent: 'ctp-latte-blue',  neutral: 'ctp-latte',    preferredMode: 'light', group: 'community' },
  dracula:        { label: 'Dracula',          description: 'Purple on a night-blue grey.',     accent: 'dracula-purple',  neutral: 'dracula',      preferredMode: 'dark',  group: 'community' },
  'tokyo-night':  { label: 'Tokyo Night',      description: 'Neon blue on midnight.',           accent: 'tokyo-blue',      neutral: 'tokyo-night',  preferredMode: 'dark',  group: 'community' },
  gruvbox:        { label: 'Gruvbox',          description: 'Retro orange on warm brown.',      accent: 'gruvbox-orange',  neutral: 'gruvbox',      preferredMode: 'dark',  group: 'community' },
  'solarized-dark': { label: 'Solarized Dark', description: 'Cyan on deep sea green.',          accent: 'solarized-cyan',  neutral: 'solarized',    preferredMode: 'dark',  group: 'community' },
  'one-dark':     { label: 'One Dark',         description: 'Editor blue on charcoal.',          accent: 'one-blue',        neutral: 'one-dark',     preferredMode: 'dark',  group: 'community' },

  // Custom (always last): any accent on the Nova neutrals
  custom: { label: 'Custom', description: 'Pick your own accent on the Nova neutrals.', accent: 'teal', neutral: 'stone', group: 'custom' },
}

/** Preset keys that existed before the 2026-09 redesign, mapped to what
 *  replaced them, so a browser that stored one lands somewhere sensible
 *  instead of on a key that no longer exists. */
export const LEGACY_PRESETS: Record<string, string> = {
  default: 'nova',
  ocean: 'slate',
  forest: 'nova',
  sunset: 'ember',
  'tailwind-teal': 'nova',
}

/** A preset key as stored anywhere (a browser, the instance setting),
 *  whichever era wrote it: the key itself if it exists, its replacement if
 *  it was retired, null if it never meant anything. */
export function normalizePreset(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // own keys only: 'constructor' is not a theme
  if (Object.prototype.hasOwnProperty.call(themePresets, raw)) return raw
  return Object.prototype.hasOwnProperty.call(LEGACY_PRESETS, raw) ? LEGACY_PRESETS[raw] : null
}

export interface ResolvedPalette {
  accent: ColorScale
  neutral: ColorScale
  secondary: ColorScale
  card: { light: string; dark: string }
}

/** The scales a preset paints with — one function, so the store and the
 *  picker's swatches can never disagree about what a theme looks like. An
 *  unknown preset resolves to Nova rather than to nothing. */
export function resolvePalette(presetKey: string, customAccent = 'teal'): ResolvedPalette {
  const preset = themePresets[normalizePreset(presetKey) ?? DEFAULT_PRESET]
  const accentKey = preset.group === 'custom' ? customAccent : preset.accent
  const accent = accentPalettes[accentKey] ?? accentPalettes.teal
  const neutral = neutralPalettes[preset.neutral] ?? neutralPalettes.stone
  const secondary = (preset.secondary && accentPalettes[preset.secondary]) || accent
  const card = cardSurface[preset.neutral] ?? cardSurface.stone
  return { accent, neutral, secondary, card }
}
