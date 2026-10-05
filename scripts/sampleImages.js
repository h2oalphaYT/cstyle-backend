// Draws simple, recognisable garment illustrations as SVG so the seed data has real images
// that flow through the same storage/URL pipeline as admin uploads. No external downloads needed.

const W = 900;
const H = 1200;

const shade = (hex, amount) => {
    const n = parseInt(hex.slice(1), 16);
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    const r = clamp(((n >> 16) & 255) * (1 + amount));
    const g = clamp(((n >> 8) & 255) * (1 + amount));
    const b = clamp((n & 255) * (1 + amount));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};

const isLight = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 170;
};

// Garment outlines on a 900×1200 canvas.
const SHAPES = {
    tee: {
        body: 'M330 255 L392 228 Q450 272 508 228 L570 255 L700 335 L648 445 L585 410 L585 905 Q450 925 315 905 L315 410 L252 445 L200 335 Z',
        details: (c) => `<path d="M392 228 Q450 300 508 228" fill="none" stroke="${shade(c, -0.25)}" stroke-width="12"/>
            <path d="M252 445 L200 335 M648 445 L700 335" stroke="${shade(c, -0.2)}" stroke-width="6" fill="none"/>`,
        detailFocus: { x: 450, y: 300, scale: 2.3 },
    },
    shirt: {
        body: 'M392 222 L330 248 L288 282 L222 712 L292 728 L330 448 L330 845 Q450 862 570 845 L570 448 L608 728 L678 712 L612 282 L570 248 L508 222 Q450 250 392 222 Z',
        details: (c) => {
            const d = shade(c, -0.22);
            const buttons = [340, 420, 500, 580, 660, 740].map(y => `<circle cx="462" cy="${y}" r="7" fill="${shade(c, 0.25)}" stroke="${d}" stroke-width="2"/>`).join('');
            return `<path d="M392 222 L450 312 L418 232 Z M508 222 L450 312 L482 232 Z" fill="${shade(c, 0.08)}" stroke="${d}" stroke-width="4"/>
                <line x1="450" y1="312" x2="450" y2="850" stroke="${d}" stroke-width="4"/>${buttons}
                <path d="M222 712 L292 728 M608 728 L678 712" stroke="${d}" stroke-width="10"/>
                <path d="M350 470 L420 470 L420 540 L350 540 Z" fill="none" stroke="${d}" stroke-width="3"/>`;
        },
        detailFocus: { x: 450, y: 330, scale: 2.1 },
    },
    mandarin: {
        body: 'M392 222 L330 248 L288 282 L222 712 L292 728 L330 448 L330 845 Q450 862 570 845 L570 448 L608 728 L678 712 L612 282 L570 248 L508 222 Q450 250 392 222 Z',
        details: (c) => {
            const d = shade(c, -0.22);
            const buttons = [300, 380, 460, 540].map(y => `<circle cx="458" cy="${y}" r="7" fill="${shade(c, 0.25)}" stroke="${d}" stroke-width="2"/>`).join('');
            return `<path d="M388 214 Q450 246 512 214 L512 236 Q450 268 388 236 Z" fill="${shade(c, 0.06)}" stroke="${d}" stroke-width="4"/>
                <line x1="450" y1="250" x2="450" y2="600" stroke="${d}" stroke-width="4"/>${buttons}
                <path d="M222 712 L292 728 M608 728 L678 712" stroke="${d}" stroke-width="10"/>`;
        },
        detailFocus: { x: 450, y: 300, scale: 2.2 },
    },
    camp: {
        body: 'M392 222 L330 248 L222 340 L262 470 L330 440 L330 845 Q450 862 570 845 L570 440 L638 470 L678 340 L570 248 L508 222 Q450 250 392 222 Z',
        details: (c) => {
            const d = shade(c, -0.22);
            const buttons = [440, 520, 600, 680, 760].map(y => `<circle cx="458" cy="${y}" r="7" fill="${shade(c, 0.25)}" stroke="${d}" stroke-width="2"/>`).join('');
            return `<path d="M392 222 L360 300 L450 400 Z M508 222 L540 300 L450 400 Z" fill="${shade(c, 0.1)}" stroke="${d}" stroke-width="4"/>
                <line x1="450" y1="400" x2="450" y2="850" stroke="${d}" stroke-width="4"/>${buttons}`;
        },
        detailFocus: { x: 450, y: 330, scale: 2.1 },
    },
    polo: {
        body: 'M330 255 L392 228 Q450 252 508 228 L570 255 L700 335 L648 445 L585 410 L585 905 Q450 925 315 905 L315 410 L252 445 L200 335 Z',
        details: (c) => {
            const d = shade(c, -0.25);
            return `<path d="M392 228 L440 300 L380 290 Z M508 228 L460 300 L520 290 Z" fill="${shade(c, 0.1)}" stroke="${d}" stroke-width="4"/>
                <rect x="437" y="250" width="26" height="150" fill="none" stroke="${d}" stroke-width="4"/>
                <circle cx="450" cy="290" r="6" fill="${shade(c, 0.3)}"/><circle cx="450" cy="345" r="6" fill="${shade(c, 0.3)}"/>
                <path d="M252 445 L200 335 M648 445 L700 335" stroke="${d}" stroke-width="10" fill="none"/>`;
        },
        detailFocus: { x: 450, y: 300, scale: 2.3 },
    },
    shorts: {
        body: 'M298 330 L602 330 L622 760 L462 776 L450 520 L438 776 L278 760 Z',
        details: (c) => {
            const d = shade(c, -0.25);
            return `<rect x="298" y="300" width="304" height="52" fill="${shade(c, -0.08)}" stroke="${d}" stroke-width="4"/>
                <path d="M430 352 Q425 420 410 450 M470 352 Q475 420 490 450" stroke="${shade(c, 0.35)}" stroke-width="5" fill="none"/>
                <path d="M450 352 L450 520" stroke="${d}" stroke-width="4"/>
                <path d="M318 370 Q350 420 330 470 M582 370 Q550 420 570 470" stroke="${d}" stroke-width="4" fill="none"/>`;
        },
        detailFocus: { x: 450, y: 380, scale: 2.2 },
    },
    trousers: {
        body: 'M305 245 L595 245 L604 300 L646 1105 L486 1115 L450 520 L414 1115 L254 1105 L296 300 Z',
        details: (c) => {
            const d = shade(c, -0.25);
            const loops = [330, 400, 500, 570].map(x => `<rect x="${x}" y="240" width="12" height="62" fill="${shade(c, -0.12)}"/>`).join('');
            return `<rect x="300" y="245" width="300" height="55" fill="${shade(c, -0.08)}" stroke="${d}" stroke-width="4"/>${loops}
                <circle cx="450" cy="272" r="9" fill="${shade(c, 0.3)}"/>
                <path d="M450 300 L450 520 M360 330 L340 1100 M540 330 L560 1100" stroke="${d}" stroke-width="3" fill="none" opacity="0.7"/>
                <path d="M312 320 Q350 380 322 430 M588 320 Q550 380 578 430" stroke="${d}" stroke-width="4" fill="none"/>`;
        },
        detailFocus: { x: 450, y: 330, scale: 2.1 },
    },
};

const fabricPattern = (id, color, fabric) => {
    if (fabric === 'stripe') {
        return `<pattern id="${id}" width="40" height="40" patternUnits="userSpaceOnUse">
            <rect width="40" height="40" fill="#F4F1EA"/><rect width="40" height="16" fill="${color}"/></pattern>`;
    }
    const line = shade(color, isLight(color) ? -0.08 : 0.12);
    if (fabric === 'linen') {
        return `<pattern id="${id}" width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="${color}"/>
            <path d="M0 3 H12 M0 9 H12" stroke="${line}" stroke-width="1" opacity="0.6"/>
            <path d="M4 0 V12" stroke="${line}" stroke-width="1" opacity="0.35"/></pattern>`;
    }
    if (fabric === 'pique') {
        return `<pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse">
            <rect width="10" height="10" fill="${color}"/><circle cx="5" cy="5" r="1.6" fill="${line}" opacity="0.6"/></pattern>`;
    }
    return `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill="${color}"/><path d="M0 8 L8 0" stroke="${line}" stroke-width="1" opacity="0.35"/></pattern>`;
};

const BACKDROPS = [
    ['#F3EFE8', '#DED6CA'],
    ['#ECEAE6', '#D4D0C8'],
    ['#E9E4DC', '#CFC6B8'],
];

/**
 * @param {object} o
 * @param {keyof SHAPES} o.shape
 * @param {string} o.color  hex
 * @param {'linen'|'cotton'|'pique'|'stripe'} [o.fabric]
 * @param {'front'|'back'|'detail'} [o.view]
 */
export const garmentSvg = ({ shape, color, fabric = 'cotton', view = 'front', width = W, height = H }) => {
    const s = SHAPES[shape];
    const [bgA, bgB] = BACKDROPS[view === 'front' ? 0 : view === 'back' ? 1 : 2];
    const focus = s.detailFocus;
    const transform = view === 'detail'
        ? `translate(${W / 2} ${H / 2}) scale(${focus.scale}) translate(${-focus.x} ${-focus.y})`
        : view === 'back' ? `translate(${W} 0) scale(-1 1)` : '';
    const details = view === 'back' ? '' : s.details(color);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>
    <linearGradient id="light" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity="0.16"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.20"/></linearGradient>
    ${fabricPattern('fabric', color, fabric)}
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity="0.22"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${view === 'detail' ? '' : `<ellipse cx="450" cy="${shape === 'trousers' ? 1135 : shape === 'shorts' ? 800 : ['shirt', 'mandarin', 'camp'].includes(shape) ? 875 : 945}" rx="250" ry="26" fill="#000" opacity="0.10"/>`}
  <g transform="${transform}">
    <g filter="url(#shadow)"><path d="${s.body}" fill="url(#fabric)" stroke="${shade(color, -0.3)}" stroke-width="3"/></g>
    <path d="${s.body}" fill="url(#light)"/>
    ${details}
  </g>
  <text x="48" y="${H - 48}" font-family="Arial, Helvetica, sans-serif" font-size="26" letter-spacing="8" fill="#000" opacity="0.28">CSTYLE</text>
</svg>`;
};

// Dark, wide composition used for hero / promo banners and category tiles.
export const sceneSvg = ({ items, width = 2400, height = 1000, background = ['#141414', '#0B0B0B'] }) => {
    const slot = width / (items.length + 1);
    const garments = items.map((it, i) => {
        const scale = (height * 0.82) / H;
        const x = slot * (i + 1) - (W * scale) / 2;
        const y = height * 0.1;
        const inner = garmentSvg({ ...it, view: 'front' })
            .replace(/<svg[^>]*>/, '')
            .replace('</svg>', '')
            .replace(/<rect width="900" height="1200" fill="url\(#bg\)"\/>/, '')
            .replace(/<text[\s\S]*?<\/text>/, '')
            .replace(/id="(\w+)"/g, `id="$1${i}"`)
            .replace(/url\(#(\w+)\)/g, `url(#$1${i})`);
        return `<g transform="translate(${x} ${y}) scale(${scale})">${inner}</g>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><radialGradient id="glow" cx="0.5" cy="0.45" r="0.7"><stop offset="0" stop-color="${background[0]}"/><stop offset="1" stop-color="${background[1]}"/></radialGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <rect x="0" y="${height - 6}" width="${width}" height="6" fill="#D4AF37" opacity="0.6"/>
  ${garments}
</svg>`;
};
