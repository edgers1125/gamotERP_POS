// Stops Android's "camera compatibility" treatment from rotating the POS when the camera opens.
//
// The REAL fix is app.json "orientation": "default" — the treatment only targets fixed-orientation activities, and
// the emulator (Pixel Tablet) still rotated the whole app with only these opt-outs while the app was locked to
// "landscape". Don't lock the orientation again; lock rotation device-wide instead (kiosk / auto-rotate off).
// These opt-outs stay as a second guard. Background: when the app was locked to landscape, On large screens Android treats a fixed-orientation app
// that opens the camera as possibly camera-unaware and "helps" it: it force-rotates / letterboxes the activity to
// match the camera sensor (usually portrait) and may restart it — the whole POS turns sideways while scanning a
// barcode or the enrollment QR. Our camera (expo-camera → CameraX PreviewView) already handles rotation correctly,
// so we opt out of every such treatment. Names verified against android.jar 36/37 (WindowManager.PROPERTY_*);
// unknown properties are ignored by older Android versions.
const { withAndroidManifest } = require('expo/config-plugins');

const PROPERTIES = [
  'android.window.PROPERTY_CAMERA_COMPAT_ALLOW_FORCE_ROTATION',
  'android.window.PROPERTY_CAMERA_COMPAT_ALLOW_REFRESH',
  'android.window.PROPERTY_CAMERA_COMPAT_ALLOW_SIMULATE_REQUESTED_ORIENTATION',
  'android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE',
];

function setFalse(node) {
  node.property = (node.property ?? []).filter((p) => !PROPERTIES.includes(p.$['android:name']));
  for (const name of PROPERTIES) node.property.push({ $: { 'android:name': name, 'android:value': 'false' } });
}

module.exports = function withNoCameraCompatRotation(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) return cfg;
    // Declared on the application and on the main activity: some of these are read per app, some per activity.
    setFalse(application);
    const main = (application.activity ?? []).find((a) => a.$['android:name'] === '.MainActivity');
    if (main) setFalse(main);
    return cfg;
  });
};
