import { requireOptionalNativeModule } from 'expo';

import type { PosDeviceNativeModule } from './PosDevice.types';

// Optional so that importing this file never crashes where the native code isn't built in (Expo Go, web, iOS, tests);
// callers get `null` and report it (src/device/deviceKey.ts throws a clear error).
const PosDevice = requireOptionalNativeModule<PosDeviceNativeModule>('PosDevice');

export default PosDevice;
