// Fetches the OpenFreeMap "liberty" style and recolors it toward the
// Google Maps palette. Pattern-matched by layer id so upstream style
// changes degrade gracefully instead of breaking.
/* global fetch */

const GOOGLE = {
  land: '#f2f1ec',
  water: '#aadaff',
  park: '#c5e8c5',
  wood: '#b8ddb0',
  building: '#e8e6e1',
  motorway: '#fcd975',
  motorwayCasing: '#e8b64c',
  majorRoad: '#fde293',
  majorCasing: '#e9cc84',
  road: '#ffffff',
  roadCasing: '#d9d7d2',
  path: '#e8e6e1',
  rail: '#d9d7d2',
  boundary: '#b8b6b0',
  labelText: '#565656',
  roadLabel: '#7d7d7d',
  waterLabel: '#6493c4',
};

function recolorLayer(layer) {
  const id = layer.id.toLowerCase();
  const paint = layer.paint || {};

  const set = (prop, val) => {
    paint[prop] = val;
    layer.paint = paint;
  };

  if (layer.type === 'background') return set('background-color', GOOGLE.land);

  if (/water|ocean|river|lake/.test(id) && layer.type === 'fill')
    return set('fill-color', GOOGLE.water);
  if (/water/.test(id) && layer.type === 'line') return set('line-color', '#8ec8f5');

  if (/park|cemetery|pitch|grass|garden|golf/.test(id) && layer.type === 'fill')
    return set('fill-color', GOOGLE.park);
  if (/wood|forest/.test(id) && layer.type === 'fill') return set('fill-color', GOOGLE.wood);
  if (/landcover/.test(id) && layer.type === 'fill') return set('fill-color', GOOGLE.park);
  if (/landuse|residential/.test(id) && layer.type === 'fill')
    return set('fill-color', GOOGLE.land);
  if (/building/.test(id) && (layer.type === 'fill' || layer.type === 'fill-extrusion')) {
    if (layer.type === 'fill') return set('fill-color', GOOGLE.building);
    return set('fill-extrusion-color', GOOGLE.building);
  }

  if (layer.type === 'line') {
    if (/motorway|trunk/.test(id) && /casing/.test(id)) return set('line-color', GOOGLE.motorwayCasing);
    if (/motorway|trunk/.test(id)) return set('line-color', GOOGLE.motorway);
    if (/primary|secondary/.test(id) && /casing/.test(id)) return set('line-color', GOOGLE.majorCasing);
    if (/primary|secondary/.test(id)) return set('line-color', GOOGLE.majorRoad);
    if (/tertiary|minor|service|street|link|road/.test(id) && /casing/.test(id))
      return set('line-color', GOOGLE.roadCasing);
    if (/tertiary|minor|service|street|link|road/.test(id)) return set('line-color', GOOGLE.road);
    if (/path|track|cycle|footway|pedestrian/.test(id)) return set('line-color', GOOGLE.path);
    if (/rail|transit/.test(id)) return set('line-color', GOOGLE.rail);
    if (/boundary|admin/.test(id)) return set('line-color', GOOGLE.boundary);
  }

  if (layer.type === 'symbol') {
    // Reduce POI clutter, keep places/roads/water labels.
    if (/poi/.test(id)) {
      layer.layout = layer.layout || {};
      layer.layout.visibility = 'none';
      return;
    }
    if (/water/.test(id)) return set('text-color', GOOGLE.waterLabel);
    if (/road|highway|street/.test(id)) return set('text-color', GOOGLE.roadLabel);
    set('text-color', GOOGLE.labelText);
    if (paint['text-halo-color']) set('text-halo-color', 'rgba(255,255,255,0.9)');
  }
}

async function googleishStyle() {
  const resp = await fetch('https://tiles.openfreemap.org/styles/liberty');
  const style = await resp.json();
  for (const layer of style.layers) {
    try {
      recolorLayer(layer);
    } catch (_) {
      /* leave layer as-is */
    }
  }
  return style;
}

window.googleishStyle = googleishStyle;
