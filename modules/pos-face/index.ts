// Local Expo module: the attendance kiosk's front camera + ML Kit face detection (Kotlin, CameraX). Android only; absent
// in Expo Go (PosFace === null → the kiosk records punches without photos, liveness SKIPPED). See CLAUDE.md
// "Attendance kiosk mode".
export { default, PosFaceCameraView, isPosFaceAvailable } from './src/PosFaceModule';
export * from './src/PosFace.types';
