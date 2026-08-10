// Machine-local display units. Project data, planning, validation, and export remain SI.
(function () {
  const STORAGE_KEY = 'bordeaux.unitSystem';
  const definitions = {
    m: { label: 'ft', factor: 3.280839895013123 },
    in: { label: 'in', factor: 39.37007874015748 },
    'm/s': { label: 'ft/s', factor: 3.280839895013123 },
    'm/s²': { label: 'ft/s²', factor: 3.280839895013123 },
    'm²': { label: 'ft²', factor: 10.763910416709722 },
    '1/m': { label: '1/ft', factor: 0.3048 },
    kg: { label: 'lb', factor: 2.2046226218487757 },
    'N·m': { label: 'lb·ft', factor: 0.7375621492772656 },
    'kg·m²': { label: 'lb·ft²', factor: 23.73036040423187 },
  };
  let current = 'metric';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'imperial') current = stored;
  } catch (_) {}

  const definition = (unit, imperialUnit) => definitions[imperialUnit || unit];
  const fromCanonical = (value, unit, imperialUnit) => current === 'imperial' && definition(unit, imperialUnit)
    ? value * definition(unit, imperialUnit).factor : value;
  const toCanonical = (value, unit, imperialUnit) => current === 'imperial' && definition(unit, imperialUnit)
    ? value / definition(unit, imperialUnit).factor : value;
  const label = (unit, imperialUnit) => current === 'imperial' && definition(unit, imperialUnit)
    ? definition(unit, imperialUnit).label : unit;
  const format = (value, unit, precision, imperialUnit) => fromCanonical(value, unit, imperialUnit).toFixed(precision) + ' ' + label(unit, imperialUnit);
  const set = (next) => {
    current = next === 'imperial' ? 'imperial' : 'metric';
    document.documentElement.dataset.units = current;
    try { localStorage.setItem(STORAGE_KEY, current); } catch (_) {}
    return current;
  };
  document.documentElement.dataset.units = current;

  window.UnitPrefs = { current: () => current, set, fromCanonical, toCanonical, label, format };
})();
