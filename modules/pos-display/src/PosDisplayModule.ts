import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { PosDisplayEvents } from './PosDisplay.types';

declare class PosDisplayModule extends NativeModule<PosDisplayEvents> {
  /** A presentation display (HDMI / USB-C monitor, or the emulator's simulated one) is connected. */
  isAvailable(): boolean;
  /** JSON of PosDisplayNativeConfig. */
  setConfig(json: string): void;
  /** JSON of PosDisplayCartState. */
  showCart(json: string): void;
  /** JSON of PosDisplayThankYouState. */
  showThankYou(json: string): void;
  showIdle(): void;
  /** Writes base64 image bytes to the module's cache dir as `name` ([A-Za-z0-9._-]); resolves the absolute path. */
  saveImage(name: string, base64: string): Promise<string>;
  /** Absolute path of a cached image, or null. */
  imagePath(name: string): Promise<string | null>;
  /** Deletes every cached image not in `keep`. */
  pruneImages(keep: string[]): Promise<void>;
  readConfigCache(): Promise<string | null>;
  writeConfigCache(json: string): Promise<void>;
}

// Optional: null in Expo Go / web / iOS, where every customer-display call becomes a no-op (src/display/).
const PosDisplay = requireOptionalNativeModule<PosDisplayModule>('PosDisplay');

export default PosDisplay;
