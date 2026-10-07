package com.medsource.gamoterp.posface

import android.content.Context
import android.content.pm.PackageManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// Attendance kiosk camera (CLAUDE.md "Attendance kiosk mode"): a front-camera preview with ML Kit face detection running
// on every analysis frame (PosFaceCameraView), plus the small file API for the punch frames it saves. JS runs the
// liveness challenge itself (src/attendance/liveness.ts) from the `onFaces` events and asks the view for a frame
// (captureFrame) at the right moments. Frames are JPEG files under filesDir/attendance_frames/ until the punch that
// lists them has been uploaded and confirmed (then JS deletes them with deleteFrames).

/** Sent as PosAttendancePunchPayload.liveness.engine — keep in step with the ML Kit version in android/build.gradle. */
internal const val FACE_ENGINE = "mlkit-face-detection@16.1.7"
private const val FRAMES_DIR = "attendance_frames"

internal fun framesDir(context: Context): File = File(context.filesDir, FRAMES_DIR)

/** Only files directly inside the frames directory (never anything else on the device). */
internal fun frameFileOrNull(context: Context, path: String): File? {
  val dir = framesDir(context).canonicalFile
  val file = File(path.removePrefix("file://")).canonicalFile
  return if (file.parentFile == dir && file.name.endsWith(".jpg")) file else null
}

class PosFaceModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PosFace")

    /** The liveness engine id + version (PosAttendancePunchPayload.liveness.engine). */
    Function("engine") { FACE_ENGINE }

    /** Whether the tablet reports a front camera at all (a punch is still possible without one — LIVENESS_SKIPPED). */
    AsyncFunction("hasFrontCamera") {
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FRONT)
    }

    /** Deletes the given frame files (paths or file:// URIs inside the frames directory); returns how many were removed. */
    AsyncFunction("deleteFrames") { paths: List<String> ->
      var removed = 0
      for (p in paths) {
        val f = frameFileOrNull(context, p) ?: continue
        if (f.exists() && f.delete()) removed++
      }
      removed
    }

    /** Every frame file on the device: { path, modifiedAt (epoch ms), bytes } — for pruning abandoned captures. */
    AsyncFunction("listFrames") {
      val files = framesDir(context).listFiles() ?: emptyArray()
      files.filter { it.isFile && it.name.endsWith(".jpg") }.map {
        mapOf("path" to it.absolutePath, "modifiedAt" to it.lastModified().toDouble(), "bytes" to it.length().toDouble())
      }
    }

    /** Whether a frame file still exists (a queued punch whose frames are gone can't be uploaded as signed). */
    AsyncFunction("frameExists") { path: String ->
      frameFileOrNull(context, path)?.exists() == true
    }

    View(PosFaceCameraView::class) {
      // onFaces: { faces: [{ yaw, pitch, roll, leftEyeOpen, rightEyeOpen, x, y, width, height, trackingId }],
      //            frameWidth, frameHeight, timestamp } — eye probabilities −1 when unknown, box relative (0..1).
      // onCameraReady: {} ; onCameraError: { code, message }
      Events("onFaces", "onCameraReady", "onCameraError")

      Prop("active") { view: PosFaceCameraView, active: Boolean? ->
        view.setActive(active ?: false)
      }

      /** Saves the next analysed frame as JPEG (rotated upright, NOT mirrored, longest side ≤ maxSide, ≤ maxBytes).
       * Resolves { path, uri, width, height, bytes, sha256 } — sha256 = hex of the file's bytes. */
      AsyncFunction("captureFrame") { view: PosFaceCameraView, maxSide: Int, quality: Int, maxBytes: Int, promise: Promise ->
        view.requestCapture(maxSide, quality, maxBytes, promise)
      }

      OnViewDestroys { view: PosFaceCameraView ->
        view.destroy()
      }
    }
  }
}
