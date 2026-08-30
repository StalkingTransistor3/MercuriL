// Fetches the OpenFreeMap "liberty" style and recolors it to the mercuril.com
// palette — slate ground, warm cream ink. Pattern-matched by layer id so
// upstream style changes degrade gracefully instead of breaking.
//
// The basemap is deliberately low-contrast and desaturated. Everything the
// product asserts (sensors, closures, the route) is drawn on top by app.js in
// brass / jade / red, and it must be the loudest thing on screen. If the
// basemap competes, the demo stops reading.
/* global fetch */

const SLATE = {
  land: '#212c3b', // --ground: hsl(215 28% 18%)
  water: '#2c4159',
  waterLine: '#365070',
  park: '#354640',
  wood: '#31423b',
  building: '#344255',
  motorway: '#a08e6a', // warm, echoes the brass accent without claiming it
  motorwayCasing: '#76684c',
  majorRoad: '#5c697a',
  majorCasing: '#46505d',
  road: '#4b5563',
  roadCasing: '#38414d',
  path: '#49505a',
  rail: '#3d4756',
  boundary: '#5a6472',
  labelText: '#c6c0b3', // cream, dimmed
  roadLabel: '#a8a194',
  waterLabel: '#809db3',
  halo: 'rgba(33,44,59,0.85)',
};

function recolorLayer(layer) {
  const id = layer.id.toLowerCase();
  const paint = layer.paint || {};

  const set = (prop, val) => {
    paint[prop] = val;
    layer.paint = paint;
  };

  if (layer.type === 'background') return set('background-color', SLATE.land);

  if (/water|ocean|river|lake/.test(id) && layer.type === 'fill')
    return set('fill-color', SLATE.water);
  if (/water/.test(id) && layer.type === 'line') return set('line-color', SLATE.waterLine);

  if (/park|cemetery|pitch|grass|garden|golf/.test(id) && layer.type === 'fill')
    return set('fill-color', SLATE.park);
  if (/wood|forest/.test(id) && layer.type === 'fill') return set('fill-color', SLATE.wood);
  if (/landcover/.test(id) && layer.type === 'fill') return set('fill-color', SLATE.park);
  if (/landuse|residential/.test(id) && layer.type === 'fill')
    return set('fill-color', SLATE.land);
  if (/building/.test(id) && (layer.type === 'fill' || layer.type === 'fill-extrusion')) {
    if (layer.type === 'fill') return set('fill-color', SLATE.building);
    return set('fill-extrusion-color', SLATE.building);
  }

  if (layer.type === 'line') {
    if (/motorway|trunk/.test(id) && /casing/.test(id)) return set('line-color', SLATE.motorwayCasing);
    if (/motorway|trunk/.test(id)) return set('line-color', SLATE.motorway);
    if (/primary|secondary/.test(id) && /casing/.test(id)) return set('line-color', SLATE.majorCasing);
    if (/primary|secondary/.test(id)) return set('line-color', SLATE.majorRoad);
    if (/tertiary|minor|service|street|link|road/.test(id) && /casing/.test(id))
      return set('line-color', SLATE.roadCasing);
    if (/tertiary|minor|service|street|link|road/.test(id)) return set('line-color', SLATE.road);
    if (/path|track|cycle|footway|pedestrian/.test(id)) return set('line-color', SLATE.path);
    if (/rail|transit/.test(id)) return set('line-color', SLATE.rail);
    if (/boundary|admin/.test(id)) return set('line-color', SLATE.boundary);
  }

  if (layer.type === 'symbol') {
    // Reduce POI clutter, keep places/roads/water labels.
    if (/poi/.test(id)) {
      layer.layout = layer.layout || {};
      layer.layout.visibility = 'none';
      return;
    }
    // Halos flip from white to slate — a white halo on a dark basemap draws a
    // bright outline around every label and reads as fog.
    if (paint['text-halo-color']) set('text-halo-color', SLATE.halo);
    if (/water/.test(id)) return set('text-color', SLATE.waterLabel);
    if (/road|highway|street/.test(id)) return set('text-color', SLATE.roadLabel);
    set('text-color', SLATE.labelText);
  }
}

async function slateStyle() {
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

window.slateStyle = slateStyle;
// Back-compat: app.js called this googleishStyle before the mercuril.com retheme.
window.googleishStyle = slateStyle;
