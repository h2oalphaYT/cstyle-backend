/**
 * Sri Lanka public (P), bank (B) and mercantile (M) holidays as gazetted, checked against the
 * Government calendar and the Central Bank holiday lists for 2026 and 2027. Loaded by
 * `npm run setup:garment`; add the next year's gazette here when it is published.
 *
 *   [date, name, categories, poya]
 */
export const SRI_LANKA_HOLIDAYS = [
    ['2026-01-03', 'Duruthu Full Moon Poya Day', 'PB', true],
    ['2026-01-15', 'Tamil Thai Pongal Day', 'PBM'],
    ['2026-02-01', 'Navam Full Moon Poya Day', 'PB', true],
    ['2026-02-04', 'National Day (Independence Day)', 'PBM'],
    ['2026-02-15', 'Mahasivarathri Day', 'PB'],
    ['2026-03-02', 'Medin Full Moon Poya Day', 'PB', true],
    ['2026-03-21', 'Id-Ul-Fitr (Ramazan Festival Day)', 'PB'],
    ['2026-04-01', 'Bak Full Moon Poya Day', 'PB', true],
    ['2026-04-03', 'Good Friday', 'PB'],
    ['2026-04-13', 'Day prior to Sinhala & Tamil New Year Day', 'PBM'],
    ['2026-04-14', 'Sinhala & Tamil New Year Day', 'PBM'],
    ['2026-05-01', 'May Day (International Workers\' Day)', 'PBM'],
    ['2026-05-01', 'Vesak Full Moon Poya Day', 'PB', true],
    ['2026-05-02', 'Day following Vesak Full Moon Poya Day', 'PBM'],
    ['2026-05-28', 'Id-Ul-Alha (Hadji Festival Day)', 'PB'],
    ['2026-05-30', 'Adhi Poson Full Moon Poya Day', 'PB', true],
    ['2026-06-29', 'Poson Full Moon Poya Day', 'PB', true],
    ['2026-07-29', 'Esala Full Moon Poya Day', 'PB', true],
    ['2026-08-26', 'Milad-Un-Nabi (Holy Prophet\'s Birthday)', 'PBM'],
    ['2026-08-27', 'Nikini Full Moon Poya Day', 'PB', true],
    ['2026-09-26', 'Binara Full Moon Poya Day', 'PB', true],
    ['2026-10-25', 'Vap Full Moon Poya Day', 'PB', true],
    ['2026-11-08', 'Deepavali Festival Day', 'PB'],
    ['2026-11-24', 'Il Full Moon Poya Day', 'PB', true],
    ['2026-12-23', 'Unduvap Full Moon Poya Day', 'PB', true],
    ['2026-12-25', 'Christmas Day', 'PBM'],

    ['2027-01-15', 'Tamil Thai Pongal Day', 'PBM'],
    ['2027-01-22', 'Duruthu Full Moon Poya Day', 'PB', true],
    ['2027-02-04', 'National Day (Independence Day)', 'PBM'],
    ['2027-02-20', 'Navam Full Moon Poya Day', 'PB', true],
    ['2027-03-06', 'Mahasivarathri Day', 'PB'],
    ['2027-03-10', 'Id-Ul-Fitr (Ramazan Festival Day)', 'PB'],
    ['2027-03-22', 'Medin Full Moon Poya Day', 'PB', true],
    ['2027-03-26', 'Good Friday', 'PB'],
    ['2027-04-13', 'Day prior to Sinhala & Tamil New Year Day', 'PBM'],
    ['2027-04-14', 'Sinhala & Tamil New Year Day', 'PBM'],
    ['2027-04-20', 'Bak Full Moon Poya Day', 'PB', true],
    ['2027-05-01', 'May Day (International Workers\' Day)', 'PBM'],
    ['2027-05-17', 'Id-Ul-Alha (Hadji Festival Day)', 'PB'],
    ['2027-05-19', 'Vesak Full Moon Poya Day', 'PB', true],
    ['2027-05-20', 'Day following Vesak Full Moon Poya Day', 'PBM'],
    ['2027-06-18', 'Poson Full Moon Poya Day', 'PB', true],
    ['2027-07-18', 'Esala Full Moon Poya Day', 'PB', true],
    ['2027-08-15', 'Milad-Un-Nabi (Holy Prophet\'s Birthday)', 'PBM'],
    ['2027-08-16', 'Nikini Full Moon Poya Day', 'PB', true],
    ['2027-09-15', 'Binara Full Moon Poya Day', 'PB', true],
    ['2027-10-15', 'Vap Full Moon Poya Day', 'PB', true],
    ['2027-10-28', 'Deepavali Festival Day', 'PB'],
    ['2027-11-13', 'Il Full Moon Poya Day', 'PB', true],
    ['2027-12-13', 'Unduvap Full Moon Poya Day', 'PB', true],
    ['2027-12-25', 'Christmas Day', 'PBM'],
];

const CATS = { P: 'public', B: 'bank', M: 'mercantile' };

/**
 * Holiday documents for the given years. Every gazetted day is marked observed (closed, paid), which is how
 * the shop's salary sheet already treats Poya days; with mercantileOnly, only mercantile holidays close the
 * factory and the others stay on the calendar as normal working days.
 */
export const holidayDocs = (years, { mercantileOnly = false } = {}) => SRI_LANKA_HOLIDAYS
    .filter(([date]) => years.includes(Number(date.slice(0, 4))))
    .map(([date, name, cats, poya = false]) => {
        const categories = [...cats].map(c => CATS[c]);
        const mercantile = categories.includes('mercantile');
        return { date, name, categories, poya, type: mercantile ? 'mercantile' : 'public', paid: true, observed: !mercantileOnly || mercantile };
    });
