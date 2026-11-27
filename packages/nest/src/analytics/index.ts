/**
 * The Detector SDK (spec §18): every analytics feature that reacts to vessel
 * movement is a `@RegisterDetector()` provider implementing `Detector`,
 * run by `DetectorRunnerModule` on top of shared state — `VesselStateStore`,
 * `TrackBuffer`, `PairSearch`, `ZoneIndex`, `FleetDirectory` — and the
 * `AlertEmitter`. `DetectorTestHarness` runs detectors without NATS.
 *
 * @packageDocumentation
 */
export {
  AlertEmitter,
  type AlertEmitterOptions,
  type AlertForgetOptions,
  type AlertOutcome,
  type AlertPersistence,
  type AlertPublicationResult,
  type AlertPublisher,
  type AlertReplaceOptions,
  type AlertReplaceResult,
  type AlertResolution,
  type AlertResolutionPublisher,
  type AlertResolveOptions,
  type AlertRestoreUnannouncedOptions,
  type AlertSignal,
  AlertSignalError,
  type AlertUpdate,
  DEFAULT_ALERT_COOLDOWN_MS,
  DEFAULT_ALERT_REPEATED_INTERVAL_MS,
  type OpenAlert,
  type PublishedResolution,
  type UnannouncedResolution,
} from './alert-emitter.js';
export {
  type AnyDetector,
  type Detector,
  DETECTOR_ID_PATTERN,
  type DetectorAlerts,
  type DetectorAlertSignal,
  type DetectorCall,
  type DetectorContext,
  type DetectorDescriptor,
  type DetectorLogger,
  type DetectorVesselChange,
  type DetectorZoneChange,
  isDetector,
  RegisterDetector,
} from './detector.js';
export {
  DETECTORS_ENV,
  type DetectorConfigResult,
  detectorEnv,
  detectorEnvPrefix,
  parseDetectorConfig,
  parseDetectorList,
} from './detector-config.js';
export {
  type DetectorActivation,
  type DetectorActivationOptions,
  DetectorEngine,
} from './detector-engine.js';
export {
  type ActivationOutcome,
  type DetectorHook,
  DetectorMetrics,
  type PositionOutcome,
} from './detector-metrics.js';
export {
  ApiDetectorsResponse,
  DetectorDescriptionDto,
} from './detector-description.dto.js';
export {
  type DetectorDescription,
  DetectorRegistrationError,
  DetectorRegistry,
  type DetectorRegistryOptions,
  type DetectorServices,
  DetectorTimeoutError,
  type RegisteredDetector,
} from './detector-registry.js';
export { DetectorRunner } from './detector-runner.js';
export {
  DetectorRunnerModule,
  type DetectorRunnerModuleAsyncOptions,
} from './detector-runner.module.js';
export {
  ALERT_PERSISTENCE,
  DETECTOR_CLOCK,
  DETECTOR_ENV,
  DETECTOR_RUNNER_OPTIONS,
  type DetectorRunnerOptions,
} from './detector-runner.options.js';
export {
  DEFAULT_HARNESS_STEP_MS,
  DetectorTestHarness,
  type DetectorTestHarnessOptions,
  makeTestVesselSnapshot,
  makeTestZone,
  type TestPositionInput,
  type TestZoneInput,
} from './detector-test-harness.js';
export { FleetDirectory, type VesselChange } from './fleet-directory.js';
export {
  type ArcDistance,
  arcBBox,
  bboxIntersects,
  DEFAULT_DISTANCE_MODEL,
  destinationPoint,
  type DistanceModel,
  distanceToArc,
  geodesicDistanceM,
  haversineM,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated alias kept for compatibility
  haversineMeters,
  initialBearingDeg,
  interpolateGreatCircle,
  MEAN_EARTH_RADIUS_M,
  nearestPointOnArc,
  searchBox,
  vincentyM,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated alias kept for compatibility
  vincentyMeters,
  WGS84_FLATTENING,
  WGS84_SEMI_MAJOR_AXIS_M,
  WGS84_SEMI_MINOR_AXIS_M,
} from './geodesy.js';
export {
  type Neighbour,
  type NeighbourQuery,
  type Pair,
  type PairPoint,
  PairSearch,
  type PairSearchOptions,
} from './pair-search.js';
export {
  TrackBuffer,
  type TrackBufferOptions,
  type TrackPoint,
} from './track-buffer.js';
export {
  type PreviousVesselPosition,
  toPositionPayload,
  toVesselPosition,
  type VesselPosition,
} from './vessel-position.js';
export {
  DEFAULT_VESSEL_STATE_KEY_PREFIX,
  type FreshnessOptions,
  RedisVesselStateMirror,
  type RedisVesselStateMirrorOptions,
  type VesselState,
  type VesselStateMirror,
  type VesselStateRemovedListener,
  VesselStateStore,
  type VesselStateStoreOptions,
  type VesselStateUpsert,
} from './vessel-state-store.js';
export {
  CompiledGeometry,
  compileGeometry,
  type GeometryDistance,
  MAX_POLYGON_EDGE_M,
} from './zone-geometry.js';
export {
  type ZoneChange,
  type ZoneDistance,
  ZoneIndex,
  type ZoneIndexOptions,
  type ZoneQuery,
} from './zone-index.js';
