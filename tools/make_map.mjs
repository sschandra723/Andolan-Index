// Builds site_src/india-map.json from DataMeet's state boundaries (CC BY 4.0), which follow the official boundary
// of India as published by the Survey of India.
//
//   cd tools && npm install && node make_map.mjs path/to/Admin2.shp ../site_src/india-map.json
//
// Admin2.shp (+ .dbf .shx .prj): https://github.com/datameet/maps/tree/master/States
import mapshaper from "mapshaper";
import { geoMercator, geoPath, geoContains, geoCentroid, geoArea } from "d3-geo";
import { writeFileSync } from "node:fs";

const [shp, out = "../site_src/india-map.json", keep = "interval=2000"] = process.argv.slice(2);
if (!shp) { console.error("usage: node make_map.mjs Admin2.shp [out.json] [mapshaper simplify option, default interval=2000 (metres)]"); process.exit(2); }

const NAMES = { "Andaman & Nicobar": "Andaman and Nicobar Islands", "Jammu & Kashmir": "Jammu and Kashmir" };
const W = 1000, PAD = 8;

const files = await mapshaper.applyCommands(
  `-i "${shp}" name=states -simplify ${keep} keep-shapes -clean -o states.json format=geojson precision=0.0001 ` +
  `-dissolve + name=outline -o outline.json format=geojson precision=0.0001`);
// GeoJSON (RFC 7946) winds outer rings counter-clockwise; d3 works on the sphere and reads that as "everything except
// this shape". Reverse any feature that comes out larger than a hemisphere.
function rewind(fc) {
  if (fc.type === "GeometryCollection") fc = { type: "FeatureCollection", features: fc.geometries.map(g => ({ type: "Feature", properties: {}, geometry: g })) };
  for (const f of fc.features) {
    if (geoArea(f) <= 2 * Math.PI) continue;
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) ring.reverse();
  }
  return fc;
}
const states = rewind(JSON.parse(files["states.json"]));
const outline = rewind(JSON.parse(files["outline.json"]));

// Every place we rely on must fall inside the state India's official map puts it in.
const checks = [
  ["Ladakh", 74.31, 35.92, "Gilgit"], ["Ladakh", 74.66, 36.32, "Hunza"], ["Ladakh", 75.63, 35.30, "Skardu"],
  ["Ladakh", 79.5, 35.2, "Aksai Chin"], ["Ladakh", 76.5, 36.0, "Shaksgam Valley"],
  ["Ladakh", 77.58, 34.15, "Leh"], ["Jammu & Kashmir", 73.47, 34.37, "Muzaffarabad"], ["Jammu & Kashmir", 74.80, 34.08, "Srinagar"],
  ["Arunachal Pradesh", 91.86, 27.59, "Tawang"], ["Delhi", 77.21, 28.61, "New Delhi"], ["Tamil Nadu", 80.27, 13.08, "Chennai"],
];
for (const [st, lon, lat, label] of checks) {
  const f = states.features.find(f => f.properties.ST_NM === st);
  if (!f || !geoContains(f, [lon, lat])) { console.error(`FAIL: ${label} is not inside ${st}`); process.exit(1); }
  console.log(`ok   ${label} is inside ${st}`);
}

const proj = geoMercator().fitWidth(W - 2 * PAD, outline);
proj.translate([proj.translate()[0] + PAD, proj.translate()[1] + PAD]);
const path = geoPath(proj).digits(1);
const [[, y0], [, y1]] = path.bounds(outline);
const H = Math.ceil(y1 + PAD);
if (y0 < 0) { console.error("projection placed the map above the frame"); process.exit(1); }

const map = {
  source: "State boundaries: DataMeet India community, CC BY 4.0 (github.com/datameet/maps). Official boundary of India as per the Survey of India.",
  width: W, height: H,
  projection: { type: "mercator", k: proj.scale(), tx: proj.translate()[0], ty: proj.translate()[1] },
  outline: path(outline),
  states: states.features.map(f => {
    const name = NAMES[f.properties.ST_NM] || f.properties.ST_NM;
    const [cx, cy] = proj(geoCentroid(f));
    return { name, d: path(f), cx: Math.round(cx), cy: Math.round(cy) };
  }).sort((a, b) => a.name.localeCompare(b.name)),
};

// the browser re-implements the projection with these three numbers; make sure it matches d3 exactly
const mercator = (lon, lat) => [map.projection.tx + map.projection.k * lon * Math.PI / 180,
  map.projection.ty - map.projection.k * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
for (const [, lon, lat] of checks) {
  const a = proj([lon, lat]), b = mercator(lon, lat);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) { console.error("projection mismatch", a, b); process.exit(1); }
}
writeFileSync(out, JSON.stringify(map));
const kb = (JSON.stringify(map).length / 1024).toFixed(0);
console.log(`wrote ${out}: ${map.states.length} states, ${W}x${H}, ${kb} KB`);
