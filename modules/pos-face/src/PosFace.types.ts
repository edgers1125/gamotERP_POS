// JS API of the local `PosFace` Expo module (android/src/main/java/com/medsource/gamoterp/posface/).

/** One face from ML Kit on one analysis frame (upright, un-mirrored camera image). */
export interface PosFaceSample {
  /** headEulerAngleY, degrees. Positive = turned toward the camera's right = the person's OWN left (see liveness.ts). */
  yaw: number;
  pitch: number;
  roll: number;
  /** 0..1, −1 when ML Kit couldn't classify the eye. */
  leftEyeOpen: number;
  rightEyeOpen: number;
  /** Bounding box relative to the frame (0..1). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** −1 when not tracked. */
  trackingId: number;
}

export interface PosFacesEvent {
  faces: PosFaceSample[];
  frameWidth: number;
  frameHeight: number;
  /** epoch ms */
  timestamp: number;
}

export interface PosFaceCameraError {
  code: 'NO_ACTIVITY' | 'NO_CAMERA' | 'START_FAILED' | string;
  message: string;
}

export interface PosCapturedFrame {
  /** Absolute path inside filesDir/attendance_frames/. */
  path: string;
  /** file:// URI of the same file (for upload). */
  uri: string;
  width: number;
  height: number;
  bytes: number;
  /** Lowercase hex SHA-256 of the file's bytes (signed into the punch payload). */
  sha256: string;
}

export interface PosFaceCameraViewProps {
  /** true = camera bound + analysing; false = released. */
  active: boolean;
  onFaces?: (event: { nativeEvent: PosFacesEvent }) => void;
  onCameraReady?: (event: { nativeEvent: Record<string, never> }) => void;
  onCameraError?: (event: { nativeEvent: PosFaceCameraError }) => void;
  style?: import('react-native').StyleProp<import('react-native').ViewStyle>;
}

/** Functions on a mounted PosFaceCameraView (via its ref). */
export interface PosFaceCameraViewRef {
  captureFrame(maxSide: number, quality: number, maxBytes: number): Promise<PosCapturedFrame>;
}
