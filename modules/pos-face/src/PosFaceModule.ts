import { NativeModule, requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType, Ref } from 'react';

import type { PosFaceCameraViewProps, PosFaceCameraViewRef } from './PosFace.types';

declare class PosFaceModule extends NativeModule {
  /** e.g. 'mlkit-face-detection@16.1.7' — PosAttendancePunchPayload.liveness.engine. */
  engine(): string;
  hasFrontCamera(): Promise<boolean>;
  /** Deletes frame files (only inside the module's frames folder); resolves how many were removed. */
  deleteFrames(paths: string[]): Promise<number>;
  listFrames(): Promise<{ path: string; modifiedAt: number; bytes: number }[]>;
  frameExists(path: string): Promise<boolean>;
}

// Optional: null in Expo Go / web / iOS.
const PosFace = requireOptionalNativeModule<PosFaceModule>('PosFace');

export const isPosFaceAvailable = PosFace !== null;

/** The native camera view, or null when the module isn't in this build. Call captureFrame on its ref. */
export const PosFaceCameraView: ComponentType<PosFaceCameraViewProps & { ref?: Ref<PosFaceCameraViewRef> }> | null =
  PosFace !== null ? requireNativeView<PosFaceCameraViewProps>('PosFace') as unknown as ComponentType<PosFaceCameraViewProps & { ref?: Ref<PosFaceCameraViewRef> }> : null;

export default PosFace;
