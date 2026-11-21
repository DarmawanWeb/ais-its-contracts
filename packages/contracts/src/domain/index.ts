/**
 * Domain vocabulary shared by every service and the web app: AIS codes and
 * labels, EWS and collision risk, the alert type registry, zones and GeoJSON
 * geometries, CII grades, geodesy, units and ids.
 *
 * @packageDocumentation
 */
export * from './ais.js';
export * from './alerts.js';
export * from './audit.js';
export * from './cii.js';
export * from './ews.js';
export * from './geo.js';
export * from './geojson.js';
export * from './id.js';
export * from './locale.js';
export * from './notification.js';
export * from './safety.js';
export * from './surveillance.js';
export * from './telemetry.js';
export * from './units.js';
export * from './vessel.js';
export type { OpenVocabulary } from './vocabulary.js';
export * from './zones.js';
